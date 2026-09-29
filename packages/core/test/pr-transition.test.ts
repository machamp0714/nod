import { describe, expect, test } from "bun:test";
import { completeIssue, startIssue } from "../src/ops/agent";
import { getAutomationSettings, runAutomation, setAutomationSettings } from "../src/ops/automation";
import { listAutoTransitions, undoAutoTransition } from "../src/ops/auto-transitions";
import { archiveIssue, createIssue, getIssue, updateIssue } from "../src/ops/issues";
import { type GhRunner, type GhRunResult, linkPr, refreshPrStatus } from "../src/ops/pr-status";
import { rejectReview } from "../src/ops/human";
import { setTransitionRules } from "../src/transition-rules";
import { codeOf, eventsOf, setup } from "./helpers";

const PR_URL = "https://github.com/example/api-server/pull/128";
const PR_URL_2 = "https://github.com/example/api-server/pull/129";

function ghJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 128,
    title: "検索 API の N+1 を解消",
    url: PR_URL,
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    mergedAt: null,
    statusCheckRollup: [],
    ...over,
  });
}

// gh の代わり。呼ぶたびに渡した順の出力を返す（実 GitHub には触れない）
function gh(...outputs: Record<string, unknown>[]): GhRunner {
  let i = 0;
  return async () => {
    const over = outputs[Math.min(i++, outputs.length - 1)] ?? {};
    return { kind: "exited", exitCode: 0, stdout: ghJson(over), stderr: "" } satisfies GhRunResult;
  };
}

const failGh: GhRunner = async () => ({ kind: "exited", exitCode: 1, stdout: "", stderr: "dial tcp: no such host" });

// PR を付けたまま in_progress の Issue を作る（nod issue done を通さず、PR URL だけ付ける）
function fixture(opts: { enabled?: boolean } = {}) {
  const s = setup();
  if (opts.enabled !== false) setAutomationSettings(s.me, s.ws.key, { prReview: true });
  const make = (status = "in_progress", prUrl: string | null = PR_URL) => {
    const issue = createIssue(s.me, { workspaceId: s.ws.id, title: `PR ${status}` });
    s.db.query("UPDATE issues SET status = ?, pr_url = ? WHERE id = (SELECT id FROM issues ORDER BY id DESC LIMIT 1)").run(status, prUrl);
    return issue.id;
  };
  return { ...s, make };
}

const statusOf = (s: ReturnType<typeof setup>, ref: string) => getIssue(s.db, ref).status;

describe("PR 連動の設定", () => {
  test("既定は無効。有効にできるのは me だけ", () => {
    const s = setup();
    expect(getAutomationSettings(s.db, s.ws.key).prReview).toBe(false);
    expect(codeOf(() => setAutomationSettings(s.llm, s.ws.key, { prReview: true }))).toBe("FORBIDDEN_FOR_LLM");
    expect(setAutomationSettings(s.me, s.ws.key, { prReview: true }).prReview).toBe(true);
    // 日数の設定は変えない
    expect(getAutomationSettings(s.db, s.ws.key)).toMatchObject({ closeAfterDays: null, archiveAfterDays: null, prReview: true });
  });
});

describe("PR 状態の更新による in_review への遷移", () => {
  test("無効なら PR が open でも遷移しない", async () => {
    const s = fixture({ enabled: false });
    const ref = s.make();
    const view = await refreshPrStatus(s.me, ref, gh({}));
    expect(view.autoTransition).toBeNull();
    expect(statusOf(s, ref)).toBe("in_progress");
  });

  test("open かつ draft でない PR なら in_progress を in_review にし、記録と event を残す", async () => {
    const s = fixture();
    const ref = s.make();
    const view = await refreshPrStatus(s.llm, ref, gh({}));
    expect(view.autoTransition).toMatchObject({ source: "pr", sourceKey: PR_URL, from: "in_progress", to: "in_review", mergeCandidate: false });
    expect(statusOf(s, ref)).toBe("in_review");
    const ev = eventsOf(s.db, ref).filter((e) => e.type === "status_changed").at(-1)!;
    expect(ev).toMatchObject({ actor: "claude-code", data: { from: "in_progress", to: "in_review", automation: "pr_review" } });
    expect(ev.data.reason).toContain("PR");
    expect(listAutoTransitions(s.db, ref)).toHaveLength(1);
  });

  test("マージ済みでも done にはせず in_review にし、完了候補と記録する", async () => {
    const s = fixture();
    const ref = s.make();
    const view = await refreshPrStatus(s.me, ref, gh({ state: "MERGED", mergedAt: "2026-09-29T00:00:00Z" }));
    expect(view.autoTransition).toMatchObject({ to: "in_review", mergeCandidate: true });
    expect(statusOf(s, ref)).toBe("in_review");
    const ev = eventsOf(s.db, ref).find((e) => e.data?.automation === "pr_review")!;
    expect(ev.data.reason).toContain("完了候補");
  });

  test("draft・未マージで閉じた PR・取得失敗では遷移しない", async () => {
    const s = fixture();
    const draft = s.make();
    const closed = s.make();
    const failed = s.make();
    expect((await refreshPrStatus(s.me, draft, gh({ isDraft: true }))).autoTransition).toBeNull();
    expect((await refreshPrStatus(s.me, closed, gh({ state: "CLOSED" }))).autoTransition).toBeNull();
    expect((await refreshPrStatus(s.me, failed, failGh)).autoTransition).toBeNull();
    for (const ref of [draft, closed, failed]) expect(statusOf(s, ref)).toBe("in_progress");
  });

  test("in_progress 以外（triage・todo・done・canceled など）とアーカイブ済みは対象外", async () => {
    const s = fixture();
    const refs = ["triage", "backlog", "todo", "needs_clarification", "in_review", "done", "canceled"].map((st) => [st, s.make(st)] as const);
    for (const [st, ref] of refs) {
      expect((await refreshPrStatus(s.me, ref, gh({}))).autoTransition).toBeNull();
      expect(statusOf(s, ref) as string).toBe(st);
    }
    const archived = s.make("done");
    archiveIssue(s.me, archived);
    s.db.query("UPDATE issues SET status = 'in_progress' WHERE archived_at IS NOT NULL").run();
    expect((await refreshPrStatus(s.me, archived, gh({}))).autoTransition).toBeNull();
    expect(statusOf(s, archived)).toBe("in_progress");
  });

  test("同じ PR では二度遷移しない（差し戻し後に PR がマージされても戻さない）。PR が変われば再び対象", async () => {
    const s = fixture();
    const ref = s.make();
    await refreshPrStatus(s.me, ref, gh({}));
    updateIssue(s.me, ref, { status: "in_progress" }); // 差し戻し
    const again = await refreshPrStatus(s.me, ref, gh({ state: "MERGED", mergedAt: "2026-09-29T00:00:00Z" }));
    expect(again.autoTransition).toBeNull();
    expect(statusOf(s, ref)).toBe("in_progress");
    await Bun.sleep(2); // 差し戻しと同じミリ秒に付け直すと、付けたあとの差し戻しとして扱う
    linkPr(s.me, ref, PR_URL_2);
    const next = await refreshPrStatus(s.me, ref, gh({ number: 129, url: PR_URL_2 }));
    expect(next.autoTransition).toMatchObject({ sourceKey: PR_URL_2 });
    expect(listAutoTransitions(s.db, ref)).toHaveLength(2);
  });

  test("作業状況は手動移動と同じく done 以外なら外す", async () => {
    const s = fixture();
    const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "LLM 作業中" });
    startIssue(s.llm, issue.id);
    s.db.query("UPDATE issues SET pr_url = ?").run(PR_URL);
    await refreshPrStatus(s.me, issue.id, gh({}));
    expect(getIssue(s.db, issue.id)).toMatchObject({ status: "in_review", agentState: null });
  });

  test("nod issue done で PR を付けて in_review になり、差し戻された Issue は同じ PR では戻さない（人の差し戻しを覆さない）", async () => {
    const s = fixture();
    const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "差し戻し" });
    startIssue(s.llm, issue.id);
    completeIssue(s.llm, issue.id, { summary: "直した", prUrl: PR_URL });
    rejectReview(s.me, issue.id, "テストが足りない");
    expect(statusOf(s, issue.id)).toBe("in_progress");
    expect((await refreshPrStatus(s.llm, issue.id, gh({}))).autoTransition).toBeNull();
    expect(statusOf(s, issue.id)).toBe("in_progress");
    // 別の PR を紐付け直せば、その PR では再び対象になる
    await Bun.sleep(2); // 差し戻しと同じミリ秒に付け直すと、付けたあとの差し戻しとして扱う
    linkPr(s.llm, issue.id, PR_URL_2);
    expect((await refreshPrStatus(s.llm, issue.id, gh({ number: 129, url: PR_URL_2 }))).autoTransition).toMatchObject({ sourceKey: PR_URL_2 });
  });

  test("nod issue done 済み（in_review）の Issue はそのまま", async () => {
    const s = fixture();
    const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "完了報告済み" });
    startIssue(s.llm, issue.id);
    completeIssue(s.llm, issue.id, { summary: "直した", prUrl: PR_URL });
    expect((await refreshPrStatus(s.me, issue.id, gh({}))).autoTransition).toBeNull();
    expect(listAutoTransitions(s.db, issue.id)).toHaveLength(0);
  });
});

describe("自動化の実行（保存済みの PR 状態で評価）", () => {
  test("dry-run は候補だけ返し、実行で in_review にする。gh は呼ばない", async () => {
    const s = fixture({ enabled: false });
    const open = s.make();
    const draft = s.make();
    const noStatus = s.make();
    await refreshPrStatus(s.me, open, gh({}));
    await refreshPrStatus(s.me, draft, gh({ isDraft: true }));
    setAutomationSettings(s.me, s.ws.key, { prReview: true });
    const dry = runAutomation(s.llm, s.ws.key, { dryRun: true });
    const rule = dry.rules.find((r) => r.kind === "pr_review")!;
    expect(rule).toMatchObject({ enabled: true, total: 1 });
    expect(rule.candidates.map((c) => c.id)).toEqual([open]);
    expect(rule.candidates[0]).toMatchObject({ prUrl: PR_URL, prState: "OPEN" });
    expect(statusOf(s, open)).toBe("in_progress");
    const run = runAutomation(s.me, s.ws.key, {});
    expect(run.rules.find((r) => r.kind === "pr_review")!.processed).toEqual([open]);
    expect(statusOf(s, open)).toBe("in_review");
    expect(statusOf(s, draft)).toBe("in_progress");
    expect(statusOf(s, noStatus)).toBe("in_progress");
    // 2回目は記録があるので候補にならない
    expect(runAutomation(s.me, s.ws.key, { dryRun: true }).rules.find((r) => r.kind === "pr_review")!.total).toBe(0);
  });

  test("保存済みの PR 状態が Issue の現在の PR URL と違えば対象外", async () => {
    const s = fixture({ enabled: false });
    const ref = s.make();
    await refreshPrStatus(s.me, ref, gh({}));
    s.db.query("UPDATE issues SET pr_url = ?").run(PR_URL_2);
    setAutomationSettings(s.me, s.ws.key, { prReview: true });
    expect(runAutomation(s.me, s.ws.key, { dryRun: true }).rules.find((r) => r.kind === "pr_review")!.total).toBe(0);
  });

  test("無効なら pr_review ルールは enabled=false で候補なし", () => {
    const s = fixture({ enabled: false });
    s.make();
    const rule = runAutomation(s.me, s.ws.key, { dryRun: true }).rules.find((r) => r.kind === "pr_review")!;
    expect(rule).toMatchObject({ enabled: false, total: 0 });
  });

  test("targets を渡したとき pr_review の一覧がなければ PR 連動は何もしない", async () => {
    const s = fixture({ enabled: false });
    const ref = s.make();
    await refreshPrStatus(s.me, ref, gh({}));
    setAutomationSettings(s.me, s.ws.key, { prReview: true });
    const run = runAutomation(s.me, s.ws.key, { targets: { auto_close: [] } });
    expect(run.rules.find((r) => r.kind === "pr_review")!.processed).toEqual([]);
    expect(statusOf(s, ref)).toBe("in_progress");
  });
});

describe("PR を付けたあとの差し戻し", () => {
  test("PR を付けたあとに in_review から動かした Issue は、in_review になったのが付ける前でも進めない", async () => {
    const s = fixture();
    const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "付ける前にレビュー待ち" });
    startIssue(s.llm, issue.id);
    completeIssue(s.llm, issue.id, { summary: "直した" }); // PR なしで in_review
    linkPr(s.llm, issue.id, PR_URL); // in_review のまま PR を付ける
    rejectReview(s.me, issue.id, "足りない"); // 付けたあとに差し戻し
    expect((await refreshPrStatus(s.me, issue.id, gh({}))).autoTransition).toBeNull();
    expect(statusOf(s, issue.id)).toBe("in_progress");
    expect(runAutomation(s.me, s.ws.key, { dryRun: true }).rules.find((r) => r.kind === "pr_review")?.total).toBe(0);
  });
});

describe("自動遷移の取消", () => {
  test("in_review のままなら元の状態に戻し、取消を記録する。取消後も同じ PR では再遷移しない", async () => {
    const s = fixture();
    const ref = s.make();
    await refreshPrStatus(s.me, ref, gh({}));
    const undone = undoAutoTransition(s.me, ref);
    expect(undone).toMatchObject({ from: "in_progress", to: "in_review", revertedBy: "me" });
    expect(undone.revertedAt).not.toBeNull();
    expect(statusOf(s, ref)).toBe("in_progress");
    const ev = eventsOf(s.db, ref).at(-1)!;
    expect(ev).toMatchObject({ type: "status_changed", data: { from: "in_review", to: "in_progress", automation: "undo" } });
    expect(ev.data.reason).toContain("取消");
    expect((await refreshPrStatus(s.me, ref, gh({}))).autoTransition).toBeNull();
    expect(statusOf(s, ref)).toBe("in_progress");
  });

  test("LLM は取り消せない。in_review でなくなっていれば拒否。取り消す遷移がなければ NOT_FOUND", async () => {
    const s = fixture();
    const ref = s.make();
    expect(codeOf(() => undoAutoTransition(s.me, ref))).toBe("NOT_FOUND");
    await refreshPrStatus(s.me, ref, gh({}));
    expect(codeOf(() => undoAutoTransition(s.llm, ref))).toBe("FORBIDDEN_FOR_LLM");
    updateIssue(s.me, ref, { status: "done" });
    expect(codeOf(() => undoAutoTransition(s.me, ref))).toBe("NOT_IN_REVIEW");
    expect(statusOf(s, ref)).toBe("done");
  });

  test("自動遷移のあとに状態が変わっていれば、in_review に戻っていても取り消さない", async () => {
    const s = fixture();
    const ref = s.make();
    await refreshPrStatus(s.me, ref, gh({}));
    await Bun.sleep(2);
    updateIssue(s.me, ref, { status: "in_progress" });
    updateIssue(s.me, ref, { status: "in_review" });
    let err: unknown;
    try {
      undoAutoTransition(s.me, ref);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "INVALID_STATE" });
    expect((err as Error).message).toContain("自動遷移の後に状態が変わっています");
    expect(statusOf(s, ref)).toBe("in_review");
    expect(listAutoTransitions(s.db, ref)[0]?.revertedAt).toBeNull();
  });
});

describe("PR の紐付け（nod issue link-pr）", () => {
  test("作業中に draft PR を紐付け、ステータスは変えず event を残す。ready になった更新で in_review に進む", async () => {
    const s = fixture();
    const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "draft から" });
    startIssue(s.llm, issue.id);
    const linked = linkPr(s.llm, issue.id, ` ${PR_URL} `);
    expect(linked).toMatchObject({ status: "in_progress", prUrl: PR_URL });
    expect(eventsOf(s.db, issue.id).at(-1)).toMatchObject({ type: "pr_linked", actor: "claude-code", data: { from: null, to: PR_URL } });
    expect((await refreshPrStatus(s.llm, issue.id, gh({ isDraft: true }))).autoTransition).toBeNull();
    expect((await refreshPrStatus(s.llm, issue.id, gh({}))).autoTransition).toMatchObject({ from: "in_progress", to: "in_review" });
    // 同じ URL をもう一度付けても event を増やさない
    const count = eventsOf(s.db, issue.id).length;
    linkPr(s.llm, issue.id, PR_URL);
    expect(eventsOf(s.db, issue.id)).toHaveLength(count);
  });

  test("GitHub の PR URL 以外とアーカイブ済みは拒む", () => {
    const s = fixture();
    const ref = s.make("in_progress", null);
    for (const url of ["https://example.com/pull/1", "github.com/a/b/pull/1", "https://github.com/a/b/issues/1", ""]) {
      expect(codeOf(() => linkPr(s.me, ref, url))).toBe("INVALID_ARGS");
    }
    const done = s.make("done", null);
    archiveIssue(s.me, done);
    expect(codeOf(() => linkPr(s.me, done, PR_URL))).toBe("ISSUE_ARCHIVED");
  });
});

describe("遷移ルール（#73）と PR 連動", () => {
  test("in_progress → in_review を禁止していれば PR 状態の更新では進めず、自動化の実行ではスキップとして理由を返す", async () => {
    const s = fixture();
    setTransitionRules(s.me, s.ws.key, { forbidden: [{ from: "in_progress", to: "in_review" }] });
    const ref = s.make();
    const view = await refreshPrStatus(s.me, ref, gh({}));
    expect(view.autoTransition).toBeNull();
    expect(statusOf(s, ref)).toBe("in_progress");
    const rule = runAutomation(s.me, s.ws.key, {}).rules.find((r) => r.kind === "pr_review")!;
    expect(rule.processed).toEqual([]);
    expect(rule.skippedReasons).toEqual([{ id: ref, message: expect.stringContaining("In Progress → In Review") }]);
    expect(statusOf(s, ref)).toBe("in_progress");
    expect(listAutoTransitions(s.db, ref)).toEqual([]);
  });
});
