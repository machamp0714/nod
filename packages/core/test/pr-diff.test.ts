import { describe, expect, test } from "bun:test";
import { completeIssue, startIssue } from "../src/ops/agent";
import { createIssue } from "../src/ops/issues";
import {
  getPrDiff,
  PR_DIFF_FILE_MAX_BYTES,
  PR_DIFF_FILE_MAX_LINES,
  PR_DIFF_MAX_BYTES,
  PR_DIFF_MAX_FILES,
  parseUnifiedDiff,
  refreshPrDiff,
} from "../src/ops/pr-diff";
import { type GhRunner, type GhRunResult, refreshPrStatus } from "../src/ops/pr-status";
import type { PrDiffErrorCode } from "../src/types";
import { setup } from "./helpers";

const PR_URL = "https://github.com/example/api-server/pull/128";
const HEAD = "a".repeat(40);
const HEAD2 = "b".repeat(40);
const BASE = "c".repeat(40);

const ok = (stdout: string): GhRunResult => ({ kind: "exited", exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string, exitCode = 1): GhRunResult => ({ kind: "exited", exitCode, stdout: "", stderr });

const viewJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ headRefOid: HEAD, baseRefOid: BASE, changedFiles: 2, ...over });

const DIFF = [
  "diff --git a/src/search.ts b/src/search.ts",
  "index 1111111..2222222 100644",
  "--- a/src/search.ts",
  "+++ b/src/search.ts",
  "@@ -1,3 +1,4 @@",
  " import { db } from './db';",
  "-const q = 1;",
  "+const q = 2;",
  "+const r = 3;",
  " export {};",
  "diff --git a/docs/new.md b/docs/new.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/docs/new.md",
  "@@ -0,0 +1 @@",
  "+# 新しい文書",
  "\\ No newline at end of file",
  "",
].join("\n");

// gh pr view（HEAD と base）と gh api compare（差分）を引数で返し分けるスタブ。実際の gh・GitHub には触れない
function stub(view: GhRunResult | (() => GhRunResult), diff: GhRunResult | (() => GhRunResult) = ok(DIFF)) {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    const r = args[0] === "pr" ? view : diff;
    return typeof r === "function" ? r() : r;
  };
  return Object.assign(run, { calls });
}

function withPr(prUrl: string | null = PR_URL) {
  const s = setup();
  const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "検索 API の N+1" });
  if (prUrl !== null) {
    startIssue(s.llm, issue.id);
    completeIssue(s.llm, issue.id, { summary: "直した", prUrl });
  }
  return { ...s, ref: issue.id };
}

describe("parseUnifiedDiff", () => {
  test("変更・追加のファイルを分け、ハンクの中の +/- だけを数える", () => {
    const files = parseUnifiedDiff(DIFF);
    expect(files.map(({ patch: _, ...f }) => f)).toEqual([
      { path: "src/search.ts", oldPath: null, status: "modified", binary: false, additions: 2, deletions: 1, omitted: null },
      { path: "docs/new.md", oldPath: null, status: "added", binary: false, additions: 1, deletions: 0, omitted: null },
    ]);
    expect(files[0]!.patch).toBe("@@ -1,3 +1,4 @@\n import { db } from './db';\n-const q = 1;\n+const q = 2;\n+const r = 3;\n export {};");
    expect(files[1]!.patch).toBe("@@ -0,0 +1 @@\n+# 新しい文書\n\\ No newline at end of file");
  });

  test("削除・名前変更・バイナリ（2つの形）・モードだけの変更を扱う", () => {
    const text = [
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-a",
      "-b",
      "diff --git a/src/a.ts b/src/b.ts",
      "similarity index 90%",
      "rename from src/a.ts",
      "rename to src/b.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/src/c.ts b/src/d.ts",
      "similarity index 100%",
      "rename from src/c.ts",
      "rename to src/d.ts",
      "diff --git a/img/logo.png b/img/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/img/logo.png and b/img/logo.png differ",
      "diff --git a/bin/tool b/bin/tool",
      "new file mode 100755",
      "index 0000000..3333333",
      "GIT binary patch",
      "literal 10",
      "zcmV-abcdef",
      "",
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    expect(parseUnifiedDiff(text).map((f) => [f.path, f.oldPath, f.status, f.binary, f.additions, f.deletions, f.omitted, f.patch])).toEqual([
      ["old.txt", null, "deleted", false, 0, 2, null, "@@ -1,2 +0,0 @@\n-a\n-b"],
      ["src/b.ts", "src/a.ts", "renamed", false, 1, 1, null, "@@ -1 +1 @@\n-x\n+y"],
      ["src/d.ts", "src/c.ts", "renamed", false, 0, 0, null, ""],
      ["img/logo.png", null, "modified", true, 0, 0, "binary", null],
      ["bin/tool", null, "added", true, 0, 0, "binary", null],
      ["run.sh", null, "modified", false, 0, 0, null, ""],
    ]);
  });

  test("git が引用符で囲んだパス（日本語の8進表記・空白・エスケープ）を元に戻す", () => {
    const text = [
      'diff --git "a/docs/\\346\\227\\245\\346\\234\\254.md" "b/docs/\\346\\227\\245\\346\\234\\254.md"',
      "--- \"a/docs/\\346\\227\\245\\346\\234\\254.md\"",
      "+++ \"b/docs/\\346\\227\\245\\346\\234\\254.md\"",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      'diff --git "a/x \\"q\\"\\ty.txt" "b/x \\"q\\"\\ty.txt"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/x \\"q\\"\\ty.txt"',
      "@@ -0,0 +1 @@",
      "+z",
      "diff --git a/with space.txt b/with space.txt",
      "deleted file mode 100644",
      "--- a/with space.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-z",
    ].join("\n");
    expect(parseUnifiedDiff(text).map((f) => f.path)).toEqual(["docs/日本.md", 'x "q"\ty.txt', "with space.txt"]);
  });

  test("ハンクの中の '--- ' や '+++ ' で始まる行はヘッダーではなく変更として数える", () => {
    const text = ["diff --git a/a.md b/a.md", "--- a/a.md", "+++ b/a.md", "@@ -1,2 +1,2 @@", "---- old", "+++ new", " x"].join("\n");
    const [f] = parseUnifiedDiff(text);
    expect([f!.path, f!.additions, f!.deletions]).toEqual(["a.md", 1, 1]);
  });

  test("空の差分は0件", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  test(`${PR_DIFF_FILE_MAX_LINES} 行または ${PR_DIFF_FILE_MAX_BYTES} バイトを超えるファイルは本文を持たず、行数は数える`, () => {
    const big = (n: number, line: string) =>
      ["diff --git a/big.txt b/big.txt", "--- a/big.txt", "+++ b/big.txt", `@@ -0,0 +1,${n} @@`, ...Array(n).fill(`+${line}`)].join("\n");
    const [byLines] = parseUnifiedDiff(big(PR_DIFF_FILE_MAX_LINES + 1, "x"));
    expect([byLines!.patch, byLines!.omitted, byLines!.additions]).toEqual([null, "too_large", PR_DIFF_FILE_MAX_LINES + 1]);
    const [byBytes] = parseUnifiedDiff(big(2, "あ".repeat(PR_DIFF_FILE_MAX_BYTES / 3)));
    expect([byBytes!.patch, byBytes!.omitted, byBytes!.additions]).toEqual([null, "too_large", 2]);
    const [small] = parseUnifiedDiff(big(PR_DIFF_FILE_MAX_LINES - 1, "x"));
    expect(small!.omitted).toBeNull();
  });
});

describe("refreshPrDiff", () => {
  test("gh pr view で HEAD と base を取り、その SHA に固定した compare の差分を保存する（GitHub へは読み取りのみ）", async () => {
    const { me, db, ref } = withPr();
    const gh = stub(ok(viewJson()));
    const view = await refreshPrDiff(me, ref, gh);
    expect(gh.calls).toEqual([
      ["pr", "view", PR_URL, "--json", "headRefOid,baseRefOid,changedFiles"],
      ["api", "-H", "Accept: application/vnd.github.diff", `repos/example/api-server/compare/${BASE}...${HEAD}`],
    ]);
    expect(view.fetchError).toBeNull();
    expect(view.stale).toBeNull();
    expect(view.diff).toMatchObject({ prUrl: PR_URL, headSha: HEAD, baseSha: BASE, additions: 3, deletions: 1, fetchedBy: "me" });
    expect(view.diff!.files.map((f) => f.path)).toEqual(["src/search.ts", "docs/new.md"]);
    expect(getPrDiff(db, ref)).toEqual(view);
  });

  test("LLM も取得でき、アクティビティ・通知は増やさない", async () => {
    const { llm, db, ref } = withPr();
    const count = () =>
      [db.query("SELECT COUNT(*) AS n FROM events").get(), db.query("SELECT COUNT(*) AS n FROM notifications").get()] as unknown[];
    const before = count();
    const view = await refreshPrDiff(llm, ref, stub(ok(viewJson())));
    expect(view.diff?.fetchedBy).toBe(llm.actor);
    expect(count()).toEqual(before);
  });

  test("取得していなければ差分なし、PR がなければ PR URL も null で、gh は実行しない", async () => {
    const { db, ref } = withPr();
    expect(getPrDiff(db, ref)).toEqual({ issueId: ref, prUrl: PR_URL, diff: null, stale: null, fetchError: null });
    const none = withPr(null);
    expect(getPrDiff(none.db, none.ref)).toEqual({ issueId: none.ref, prUrl: null, diff: null, stale: null, fetchError: null });
    const gh = stub(ok(viewJson()));
    await expect(refreshPrDiff(none.me, none.ref, gh)).rejects.toMatchObject({ code: "INVALID_ARGS" });
    expect(gh.calls).toEqual([]);
  });

  test("GitHub の PR URL でなければ INVALID_URL で、gh は実行しない", async () => {
    const { me, ref } = withPr("https://gitlab.com/x/y/-/merge_requests/1");
    const gh = stub(ok(viewJson()));
    expect((await refreshPrDiff(me, ref, gh)).fetchError?.code).toBe("INVALID_URL");
    expect(gh.calls).toEqual([]);
  });

  test("gh の失敗は #67 と同じ分類で fetchError に入れ、前回の差分は残す", async () => {
    const { me, ref } = withPr();
    await refreshPrDiff(me, ref, stub(ok(viewJson())));
    const cases: [GhRunResult, PrDiffErrorCode][] = [
      [{ kind: "not_found" }, "GH_NOT_INSTALLED"],
      [fail("To get started with GitHub CLI, please run:  gh auth login", 4), "GH_AUTH"],
      [fail("GraphQL: Could not resolve to a PullRequest with the number of 128."), "PR_NOT_FOUND"],
      [fail("error connecting to api.github.com"), "NETWORK"],
      [{ kind: "timeout" }, "TIMEOUT"],
      [fail("boom"), "UNKNOWN"],
    ];
    for (const [result, code] of cases) {
      const view = await refreshPrDiff(me, ref, stub(result));
      expect(view.fetchError?.code).toBe(code);
      expect(view.diff?.headSha).toBe(HEAD);
    }
  });

  test("compare の失敗も分類し、失敗の後に成功すれば fetchError を消す", async () => {
    const { me, ref } = withPr();
    const failed = await refreshPrDiff(me, ref, stub(ok(viewJson()), fail("HTTP 404: Not Found (https://api.github.com/repos/...)")));
    expect(failed.fetchError?.code).toBe("PR_NOT_FOUND");
    expect(failed.diff).toBeNull();
    const fixed = await refreshPrDiff(me, ref, stub(ok(viewJson())));
    expect(fixed.fetchError).toBeNull();
    expect(fixed.diff).not.toBeNull();
  });

  test(`変更ファイルが ${PR_DIFF_MAX_FILES} 件を超えるなら compare を実行せず DIFF_TOO_LARGE`, async () => {
    const { me, ref } = withPr();
    const gh = stub(ok(viewJson({ changedFiles: PR_DIFF_MAX_FILES + 1 })));
    const view = await refreshPrDiff(me, ref, gh);
    expect(view.fetchError?.code).toBe("DIFF_TOO_LARGE");
    expect(view.fetchError?.message).toContain(String(PR_DIFF_MAX_FILES + 1));
    expect(gh.calls).toHaveLength(1);
  });

  test("GitHub が差分を大きすぎると返したら DIFF_TOO_LARGE", async () => {
    const { me, ref } = withPr();
    const view = await refreshPrDiff(
      me,
      ref,
      stub(ok(viewJson()), fail("gh: Sorry, the diff exceeded the maximum number of lines (20000) (HTTP 406)")),
    );
    expect(view.fetchError?.code).toBe("DIFF_TOO_LARGE");
  });

  test(`差分全体が ${PR_DIFF_MAX_BYTES} バイトを超えたら保存せず DIFF_TOO_LARGE（文字数ではなくバイト数で数える）`, async () => {
    const { me, ref } = withPr();
    const head = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1 @@\n+";
    const over = head + "あ".repeat(Math.ceil((PR_DIFF_MAX_BYTES - head.length) / 3) + 1);
    expect(over.length).toBeLessThan(PR_DIFF_MAX_BYTES);
    const view = await refreshPrDiff(me, ref, stub(ok(viewJson()), ok(over)));
    expect(view.fetchError?.code).toBe("DIFF_TOO_LARGE");
    expect(view.diff).toBeNull();
  });

  test(`解析したファイルが ${PR_DIFF_MAX_FILES} 件を超えても DIFF_TOO_LARGE`, async () => {
    const { me, ref } = withPr();
    const many = Array.from({ length: PR_DIFF_MAX_FILES + 1 }, (_, i) => `diff --git a/f${i} b/f${i}\nold mode 100644\nnew mode 100755`).join("\n");
    expect((await refreshPrDiff(me, ref, stub(ok(viewJson()), ok(many)))).fetchError?.code).toBe("DIFF_TOO_LARGE");
  });

  test("gh pr view の出力が不正な SHA なら compare を実行せず UNKNOWN", async () => {
    const { me, ref } = withPr();
    for (const bad of [{ headRefOid: "../../x" }, { baseRefOid: "" }, { headRefOid: undefined }]) {
      const gh = stub(ok(viewJson(bad)));
      expect((await refreshPrDiff(me, ref, gh)).fetchError?.code).toBe("UNKNOWN");
      expect(gh.calls).toHaveLength(1);
    }
    const garbage = stub(ok("not json"));
    expect((await refreshPrDiff(me, ref, garbage)).fetchError?.code).toBe("UNKNOWN");
  });

  test("同じ Issue の取得中にもう一度更新しても gh を重ねて実行しない", async () => {
    const { me, ref } = withPr();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      await gate;
      return args[0] === "pr" ? ok(viewJson()) : ok(DIFF);
    };
    const a = refreshPrDiff(me, ref, gh);
    const b = refreshPrDiff(me, ref, gh);
    release();
    expect(await a).toEqual(await b);
    expect(calls).toHaveLength(2);
  });

  test("取得中に PR URL が変わったら古い URL の差分は保存しない", async () => {
    const { me, db, ref } = withPr();
    const other = "https://github.com/example/api-server/pull/129";
    const gh: GhRunner = async (args) => {
      if (args[0] === "pr") db.query("UPDATE issues SET pr_url = ? WHERE number = 1").run(other);
      return args[0] === "pr" ? ok(viewJson()) : ok(DIFF);
    };
    const view = await refreshPrDiff(me, ref, gh);
    expect(view.prUrl).toBe(other);
    expect(view.diff).toBeNull();
  });

  test("PR URL を変えたら前の PR の差分は返さない", async () => {
    const { me, db, ref } = withPr();
    await refreshPrDiff(me, ref, stub(ok(viewJson())));
    db.query("UPDATE issues SET pr_url = ? WHERE number = 1").run("https://github.com/example/api-server/pull/129");
    expect(getPrDiff(db, ref).diff).toBeNull();
  });
});

describe("HEAD が変わった差分", () => {
  const statusJson = (headRefOid: string) =>
    JSON.stringify({ number: 128, title: "t", url: PR_URL, state: "OPEN", isDraft: false, reviewDecision: null, mergedAt: null, statusCheckRollup: [], headRefOid });
  const statusGh = (head: string): GhRunner => async () => ok(statusJson(head));

  test("差分の後に PR 状態の取得で別の HEAD を知ったら、差分は返さず両方の HEAD を stale に入れる", async () => {
    const { me, db, ref } = withPr();
    await refreshPrStatus(me, ref, statusGh(HEAD));
    await refreshPrDiff(me, ref, stub(ok(viewJson())));
    expect(getPrDiff(db, ref).stale).toBeNull();
    await Bun.sleep(2);
    await refreshPrStatus(me, ref, statusGh(HEAD2));
    const view = getPrDiff(db, ref);
    expect(view.diff).toBeNull();
    expect(view.stale).toEqual({ diffHeadSha: HEAD, currentHeadSha: HEAD2 });
  });

  test("PR 状態より後に取った差分が新しい HEAD なら、差分のほうを正として表示する", async () => {
    const { me, db, ref } = withPr();
    await refreshPrStatus(me, ref, statusGh(HEAD));
    await Bun.sleep(2);
    await refreshPrDiff(me, ref, stub(ok(viewJson({ headRefOid: HEAD2 }))));
    const view = getPrDiff(db, ref);
    expect(view.stale).toBeNull();
    expect(view.diff?.headSha).toBe(HEAD2);
  });

  test("差分を取り直して HEAD がそろえば stale は消える", async () => {
    const { me, db, ref } = withPr();
    await refreshPrDiff(me, ref, stub(ok(viewJson())));
    await Bun.sleep(2);
    await refreshPrStatus(me, ref, statusGh(HEAD2));
    expect(getPrDiff(db, ref).stale).not.toBeNull();
    await Bun.sleep(2);
    await refreshPrDiff(me, ref, stub(ok(viewJson({ headRefOid: HEAD2 }))));
    expect(getPrDiff(db, ref).stale).toBeNull();
  });

  test("HEAD を持たない以前の PR 状態は判定に使わない", async () => {
    const { me, db, ref } = withPr();
    await refreshPrDiff(me, ref, stub(ok(viewJson())));
    await Bun.sleep(2);
    await refreshPrStatus(me, ref, async () => ok(statusJson(HEAD2).replace(`,"headRefOid":"${HEAD2}"`, "")));
    expect(getPrDiff(db, ref).stale).toBeNull();
  });
});
