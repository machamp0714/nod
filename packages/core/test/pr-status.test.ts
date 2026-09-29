import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createIssue } from "../src/ops/issues";
import { completeIssue, startIssue } from "../src/ops/agent";
import { copyIssue } from "../src/ops/issues";
import {
  createCommandRunner,
  type GhRunner,
  type GhRunResult,
  getPrStatus,
  parseGhPrView,
  PR_STATUS_TIMEOUT_MS,
  refreshPrStatus,
} from "../src/ops/pr-status";
import { setup } from "./helpers";

const PR_URL = "https://github.com/example/api-server/pull/128";

// gh pr view --json の出力の形（実際の GitHub には問い合わせない）
function ghJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 128,
    title: "検索 API の N+1 を解消",
    url: PR_URL,
    state: "OPEN",
    isDraft: false,
    reviewDecision: "APPROVED",
    mergedAt: null,
    statusCheckRollup: [
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/1" },
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/2" },
      { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: "", detailsUrl: "https://ci/3" },
      { __typename: "CheckRun", name: "deploy", status: "COMPLETED", conclusion: "SKIPPED", detailsUrl: null },
      { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", targetUrl: "https://ci/4" },
      { __typename: "StatusContext", context: "ci/pending", state: "PENDING", targetUrl: null },
    ],
    ...over,
  });
}

function stub(result: GhRunResult | (() => GhRunResult)): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    return typeof result === "function" ? result() : result;
  };
  return Object.assign(run, { calls });
}

const ok = (stdout = ghJson()): GhRunResult => ({ kind: "exited", exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string, exitCode = 1): GhRunResult => ({ kind: "exited", exitCode, stdout: "", stderr });

function withPr(prUrl: string | null = PR_URL) {
  const s = setup();
  const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "検索 API の N+1" });
  if (prUrl !== null) {
    startIssue(s.llm, issue.id);
    completeIssue(s.llm, issue.id, { summary: "直した", prUrl });
  }
  return { ...s, ref: issue.id };
}

describe("parseGhPrView", () => {
  test("CheckRun と StatusContext の両方を成功・失敗・実行中・スキップに分けて数える", () => {
    const p = parseGhPrView(ghJson());
    expect(p).toMatchObject({ number: 128, state: "OPEN", isDraft: false, reviewDecision: "APPROVED", mergedAt: null });
    expect(p.checks.map((c) => [c.name, c.state])).toEqual([
      ["test", "success"],
      ["lint", "failure"],
      ["e2e", "pending"],
      ["deploy", "skipped"],
      ["ci/legacy", "success"],
      ["ci/pending", "pending"],
    ]);
    expect(p.checkSummary).toEqual({ success: 2, failure: 1, pending: 2, skipped: 1 });
    expect(p.checks[0]!.url).toBe("https://ci/1");
    expect(p.checks[3]!.url).toBeNull();
  });

  test("レビュー不要（空文字）は null、チェックなしは空の集計にする", () => {
    const p = parseGhPrView(ghJson({ reviewDecision: "", statusCheckRollup: [], state: "MERGED", mergedAt: "2026-09-29T00:00:00Z" }));
    expect(p.reviewDecision).toBeNull();
    expect(p.checks).toEqual([]);
    expect(p.checkSummary).toEqual({ success: 0, failure: 0, pending: 0, skipped: 0 });
    expect(p.state).toBe("MERGED");
    expect(p.mergedAt).toBe("2026-09-29T00:00:00Z");
  });

  test("キャンセル・タイムアウト・エラーは失敗、NEUTRAL は スキップ、QUEUED は実行中として数える", () => {
    const rollup = [
      { __typename: "CheckRun", name: "a", status: "COMPLETED", conclusion: "CANCELLED" },
      { __typename: "CheckRun", name: "b", status: "COMPLETED", conclusion: "TIMED_OUT" },
      { __typename: "StatusContext", context: "c", state: "ERROR" },
      { __typename: "CheckRun", name: "d", status: "COMPLETED", conclusion: "NEUTRAL" },
      { __typename: "CheckRun", name: "e", status: "QUEUED", conclusion: "" },
      { __typename: "StatusContext", context: "f", state: "EXPECTED" },
    ];
    expect(parseGhPrView(ghJson({ statusCheckRollup: rollup })).checkSummary).toEqual({ success: 0, failure: 3, pending: 2, skipped: 1 });
  });
});

describe("PR 状態の取得と保存", () => {
  test("未取得なら status も fetchError も null で、Issue の PR URL を返す", () => {
    const { db, ref } = withPr();
    expect(getPrStatus(db, ref)).toEqual({ issueId: ref, prUrl: PR_URL, status: null, fetchError: null });
  });

  test("PR が無い Issue は prUrl も null", () => {
    const { db, ref } = withPr(null);
    expect(getPrStatus(db, ref)).toEqual({ issueId: ref, prUrl: null, status: null, fetchError: null });
  });

  test("更新すると gh pr view を読み取り専用の引数で実行し、結果・取得時刻・書き手を保存する", async () => {
    const { db, me, ref } = withPr();
    const gh = stub(ok());
    const view = await refreshPrStatus(me, ref, gh);
    expect(gh.calls).toEqual([
      ["pr", "view", PR_URL, "--json", "number,title,url,state,isDraft,reviewDecision,statusCheckRollup,mergedAt"],
    ]);
    expect(view.fetchError).toBeNull();
    expect(view.status).toMatchObject({ prUrl: PR_URL, number: 128, state: "OPEN", reviewDecision: "APPROVED", fetchedBy: "me" });
    expect(view.status!.fetchedAt).toBeString();
    expect(getPrStatus(db, ref)).toEqual(view);
  });

  test("LLM も更新でき、書き手が記録される。アクティビティには残さない", async () => {
    const { db, llm, ref } = withPr();
    const before = (db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    const view = await refreshPrStatus(llm, ref, stub(ok()));
    expect(view.status?.fetchedBy).toBe("claude-code");
    expect((db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(before);
  });

  test("PR が無い Issue の更新は INVALID_ARGS で gh を実行しない", async () => {
    const { me, ref } = withPr(null);
    const gh = stub(ok());
    await expect(refreshPrStatus(me, ref, gh)).rejects.toMatchObject({ code: "INVALID_ARGS" });
    expect(gh.calls).toEqual([]);
  });

  test("GitHub の PR URL でなければ gh を実行せず INVALID_URL を保存する", async () => {
    const { db, me, ref } = withPr("https://example.com/pr/1");
    const gh = stub(ok());
    const view = await refreshPrStatus(me, ref, gh);
    expect(gh.calls).toEqual([]);
    expect(view.fetchError).toMatchObject({ code: "INVALID_URL", message: "GitHub の PR URL ではありません" });
    expect(getPrStatus(db, ref).fetchError?.code).toBe("INVALID_URL");
  });

  const cases: [string, GhRunResult, string, string][] = [
    ["gh 未導入", { kind: "not_found" }, "GH_NOT_INSTALLED", "gh が見つかりません。GitHub CLI を導入してください"],
    ["未認証（終了コード 4）", fail("", 4), "GH_AUTH", "gh が未認証です。gh auth login を実行してください"],
    ["未認証（stderr）", fail("To get started with GitHub CLI, please run:  gh auth login"), "GH_AUTH", "gh が未認証です。gh auth login を実行してください"],
    ["PR 不存在", fail("GraphQL: Could not resolve to a PullRequest with the number of 999. (repository.pullRequest)"), "PR_NOT_FOUND", "PR が見つかりません（削除またはアクセス権なし）"],
    ["リポジトリ不存在", fail("GraphQL: Could not resolve to a Repository with the name 'x/y'. (repository)"), "PR_NOT_FOUND", "PR が見つかりません（削除またはアクセス権なし）"],
    ["ネットワーク", fail('error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com'), "NETWORK", "GitHub に接続できません"],
    ["ネットワーク（dial）", fail("Post \"https://api.github.com/graphql\": dial tcp: lookup api.github.com: no such host"), "NETWORK", "GitHub に接続できません"],
    ["タイムアウト", { kind: "timeout" }, "TIMEOUT", "15秒以内に応答がありませんでした"],
    ["その他", fail("something odd happened\nsecond line"), "UNKNOWN", "取得に失敗しました: something odd happened"],
    ["出力が JSON でない", ok("not json"), "UNKNOWN", "取得に失敗しました: gh の出力を解釈できませんでした"],
  ];
  for (const [label, result, code, message] of cases) {
    test(`失敗を分類して保存する: ${label}`, async () => {
      const { db, me, ref } = withPr();
      const view = await refreshPrStatus(me, ref, stub(result));
      expect(view.status).toBeNull();
      expect(view.fetchError).toMatchObject({ code, message });
      expect(view.fetchError!.at).toBeString();
      expect(getPrStatus(db, ref).fetchError).toEqual(view.fetchError);
    });
  }

  test("失敗しても前回の成功結果は残り、次の成功でエラーが消える", async () => {
    const { me, ref } = withPr();
    const first = await refreshPrStatus(me, ref, stub(ok()));
    const failed = await refreshPrStatus(me, ref, stub({ kind: "timeout" }));
    expect(failed.status).toEqual(first.status);
    expect(failed.fetchError?.code).toBe("TIMEOUT");
    const again = await refreshPrStatus(me, ref, stub(ok(ghJson({ state: "MERGED", mergedAt: "2026-09-30T00:00:00Z" }))));
    expect(again.fetchError).toBeNull();
    expect(again.status?.state).toBe("MERGED");
  });

  test("Issue の PR URL が変わると、前の PR の結果とエラーは出さない", async () => {
    const { db, me, ref } = withPr();
    await refreshPrStatus(me, ref, stub(ok()));
    await refreshPrStatus(me, ref, stub({ kind: "timeout" }));
    db.query("UPDATE issues SET pr_url = ? WHERE number = 1").run("https://github.com/example/api-server/pull/129");
    expect(getPrStatus(db, ref)).toMatchObject({ prUrl: "https://github.com/example/api-server/pull/129", status: null, fetchError: null });
  });

  test("同じ Issue の同時更新は gh を1回だけ実行し、同じ結果を返す", async () => {
    const { me, ref } = withPr();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const gh: GhRunner = async () => {
      calls++;
      await gate;
      return ok();
    };
    const a = refreshPrStatus(me, ref, gh);
    const b = refreshPrStatus(me, ref, gh);
    release();
    const [va, vb] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(va).toEqual(vb);
    // 終わったあとの更新は新たに実行する
    await refreshPrStatus(me, ref, gh);
    expect(calls).toBe(2);
  });

  test("後から始めた取得の結果を、先に始めて遅れて終わった取得が上書きしない（別プロセス相当）", async () => {
    const { db, ref } = withPr();
    // 別プロセスを模して、別の接続（同じ DB ファイル）から実行する
    const { openDb } = await import("../src/db");
    const other = { db: openDb(db.filename), actor: "claude-code" };
    const me = { db, actor: "me" };
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    const slow = refreshPrStatus(me, ref, async () => {
      await slowGate;
      return ok(ghJson({ state: "OPEN" }));
    });
    await Bun.sleep(5);
    await refreshPrStatus(other, ref, stub(ok(ghJson({ state: "MERGED", mergedAt: "2026-09-30T00:00:00Z" }))));
    releaseSlow();
    const late = await slow;
    expect(late.status?.state).toBe("MERGED");
    expect(getPrStatus(db, ref).status?.state).toBe("MERGED");
  });

  test("Issue を複製しても PR 状態は引き継がない", async () => {
    const { db, me, ref } = withPr();
    await refreshPrStatus(me, ref, stub(ok()));
    const copy = copyIssue(me, ref);
    expect(getPrStatus(db, copy.id)).toMatchObject({ prUrl: null, status: null, fetchError: null });
  });
});

describe("createCommandRunner（実 gh は使わない）", () => {
  test("コマンドが無ければ not_found", async () => {
    const run = createCommandRunner("nod-no-such-command-xyz");
    expect(await run(["pr", "view"], { timeoutMs: 1000 })).toEqual({ kind: "not_found" });
  });

  test("終了コード・標準出力・標準エラーを返す", async () => {
    const script = join(import.meta.dir, "fixtures", "fake-gh.ts");
    const run = createCommandRunner(process.execPath, [script]);
    expect(await run(["echo", "hello"], { timeoutMs: 5000 })).toEqual({ kind: "exited", exitCode: 3, stdout: "hello", stderr: "err" });
  });

  test("時間切れならプロセスを止めて timeout", async () => {
    const script = join(import.meta.dir, "fixtures", "fake-gh.ts");
    const run = createCommandRunner(process.execPath, [script]);
    const started = Date.now();
    expect(await run(["sleep"], { timeoutMs: 200 })).toEqual({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("既定のタイムアウトは 15 秒", () => {
    expect(PR_STATUS_TIMEOUT_MS).toBe(15_000);
  });
});
