import { describe, expect, test } from "bun:test";
import { askQuestion, completeIssue, startIssue } from "../src/ops/agent";
import {
  acceptTriage,
  answerQuestion,
  approveReview,
  declineTriage,
  duplicateTriage,
  getInbox,
  listTriage,
  parseDateTime,
  rejectReview,
  snoozeTriage,
} from "../src/ops/human";
import { createCycle } from "../src/ops/cycles";
import { createIssue, getIssue, updateIssue } from "../src/ops/issues";
import { initWorkspace } from "../src/ops/workspaces";
import { codeOf, eventsOf, setup } from "./helpers";

describe("getInbox と answerQuestion", () => {
  test("全 Workspace の未回答の確認依頼とレビュー待ちを集め、回答で消える", () => {
    const { db, ws, me, llm } = setup();
    const web = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    const b = createIssue(me, { workspaceId: web.id, title: "画面" });
    startIssue(llm, a.id, { location: { branch: "feat-a", worktree: "/wt/a" } });
    askQuestion(llm, a.id, "インデックスを足してよいか");
    startIssue(llm, b.id);
    completeIssue(llm, b.id, { summary: "直した" });

    const inbox = getInbox(db);
    expect(inbox.questions).toEqual([
      expect.objectContaining({
        issueId: a.id,
        issueTitle: "検索",
        workspace: "API",
        question: "インデックスを足してよいか",
        askedBy: "claude-code",
        branch: "feat-a",
        worktree: "/wt/a",
      }),
    ]);
    expect(inbox.reviews.map((i) => i.id)).toEqual([b.id]);

    const r = answerQuestion(me, a.id, "足してよい");
    expect(r.answered).toEqual([expect.objectContaining({ answer: "足してよい", answeredBy: "me" })]);
    expect(r.issue.agentState).toBe("working");
    expect(getInbox(db).questions).toEqual([]);
    expect(eventsOf(db, a.id).at(-1)?.type).toBe("agent_state_changed");
    expect(codeOf(() => answerQuestion(me, a.id, "もう一度"))).toBe("NO_OPEN_QUESTION");
  });

  test("done や canceled になった Issue の未回答の確認依頼は Inbox に出さない", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    const c = createIssue(me, { workspaceId: ws.id, title: "c" });
    for (const i of [a, b, c]) {
      startIssue(llm, i.id);
      askQuestion(llm, i.id, "どうするか");
    }
    updateIssue(me, a.id, { status: "done" });
    updateIssue(me, b.id, { status: "canceled" });
    expect(getInbox(db).questions.map((q) => q.issueId)).toEqual([c.id]);
  });
});

describe("Triage", () => {
  test("accept は todo にし、Triage にない Issue は NOT_IN_TRIAGE", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(llm, { workspaceId: ws.id, title: "t" });
    expect(acceptTriage(me, i.id).status).toBe("todo");
    expect(eventsOf(db, i.id).at(-1)?.type).toBe("triage_accepted");
    expect(codeOf(() => acceptTriage(me, i.id))).toBe("NOT_IN_TRIAGE");
  });

  test("accept で Cycle を付け、null で外す。存在しない Cycle は受け入れない", () => {
    const { db, ws, me, llm } = setup();
    const cycle = createCycle(me, { name: "Sprint 1", startDate: "2026-10-05", endDate: "2026-10-18" });
    const a = createIssue(llm, { workspaceId: ws.id, title: "a" });
    expect(acceptTriage(me, a.id, { cycleRef: "Sprint 1" }).cycle).toEqual({ id: cycle.id, name: "Sprint 1" });
    const b = createIssue(llm, { workspaceId: ws.id, title: "b", cycleRef: String(cycle.id) });
    expect(acceptTriage(me, b.id, { cycleRef: null }).cycle).toBeNull();
    const c = createIssue(llm, { workspaceId: ws.id, title: "c" });
    expect(codeOf(() => acceptTriage(me, c.id, { cycleRef: "Sprint 9" }))).toBe("NOT_FOUND");
    expect(getIssue(db, c.id).status).toBe("triage");
  });

  test("accept の cycleRef に current を渡すと今日を含む Cycle に入れる", () => {
    const { ws, me, llm } = setup();
    const current = createCycle(me, { name: "長期", startDate: "2000-01-01", endDate: "2999-12-31" });
    const i = createIssue(llm, { workspaceId: ws.id, title: "t" });
    expect(acceptTriage(me, i.id, { cycleRef: "current" }).cycle).toEqual({ id: current.id, name: "長期" });
  });

  test("decline は理由つきで canceled にする", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(llm, { workspaceId: ws.id, title: "t" });
    expect(declineTriage(me, i.id, "不要")).toMatchObject({ status: "canceled", closeReason: "不要" });
    expect(eventsOf(db, i.id).at(-1)).toMatchObject({ type: "triage_declined", data: { reason: "不要" } });
  });

  test("duplicate は canceled にして duplicate の関係を足す", () => {
    const { db, ws, me, llm } = setup();
    const original = createIssue(me, { workspaceId: ws.id, title: "元" });
    const dup = createIssue(llm, { workspaceId: ws.id, title: "重複" });
    expect(duplicateTriage(me, dup.id, original.id).status).toBe("canceled");
    expect(getIssue(db, dup.id).relations.duplicateOf).toEqual([original.id]);
    expect(getIssue(db, original.id).relations.duplicates).toEqual([dup.id]);
    expect(codeOf(() => duplicateTriage(me, original.id, original.id))).toBe("NOT_IN_TRIAGE");
  });

  test("snooze は triage のまま後回しの期限を入れ、accept で消える", () => {
    const { ws, me, llm } = setup();
    const i = createIssue(llm, { workspaceId: ws.id, title: "t" });
    const snoozed = snoozeTriage(me, i.id, "2099-01-01");
    expect(snoozed.status).toBe("triage");
    expect(snoozed.snoozedUntil).toBe(new Date(2099, 0, 1).toISOString());
    expect(codeOf(() => snoozeTriage(me, i.id, "来週"))).toBe("INVALID_ARGS");
    expect(acceptTriage(me, i.id).snoozedUntil).toBeNull();
  });
});

describe("parseDateTime", () => {
  test("日付はローカル時刻の0時、日時はそのまま解釈し、存在しない日付は拒む", () => {
    expect(parseDateTime("2026-10-01")).toBe(new Date(2026, 9, 1).toISOString());
    expect(parseDateTime("2026-10-01T09:00:00+09:00")).toBe("2026-10-01T00:00:00.000Z");
    expect(codeOf(() => parseDateTime("2026-02-30"))).toBe("INVALID_ARGS");
    expect(codeOf(() => parseDateTime("2026-02-30T09:00:00+09:00"))).toBe("INVALID_ARGS");
    expect(codeOf(() => parseDateTime("2026-13-01T09:00:00Z"))).toBe("INVALID_ARGS");
    expect(parseDateTime("2028-02-29T09:00:00Z")).toBe("2028-02-29T09:00:00.000Z");
    expect(codeOf(() => parseDateTime("+3d"))).toBe("INVALID_ARGS");
  });

  test("空白区切り（CLI が表示する YYYY-MM-DD HH:mm）も受け付け、オフセットが無ければローカル時刻として解釈する", () => {
    expect(parseDateTime("2026-10-01 09:00")).toBe(new Date(2026, 9, 1, 9, 0).toISOString());
    expect(parseDateTime("2026-10-01 09:00")).toBe(parseDateTime("2026-10-01T09:00"));
    expect(parseDateTime("2026-10-01 09:00:30")).toBe(new Date(2026, 9, 1, 9, 0, 30).toISOString());
    expect(parseDateTime("2026-10-01 09:00:00+09:00")).toBe("2026-10-01T00:00:00.000Z");
    expect(codeOf(() => parseDateTime("2026-02-30 09:00"))).toBe("INVALID_ARGS");
    expect(codeOf(() => parseDateTime("2026-10-01  09:00"))).toBe("INVALID_ARGS");
    expect(codeOf(() => parseDateTime("2026-10-01 25:00"))).toBe("INVALID_ARGS");
  });
});

describe("レビュー", () => {
  test("approve は done、reject は理由を残して in_progress に戻し作業状況を消す", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    startIssue(llm, a.id);
    completeIssue(llm, a.id, { summary: "やった" });
    expect(approveReview(me, a.id).status).toBe("done");
    expect(codeOf(() => approveReview(me, a.id))).toBe("NOT_IN_REVIEW");

    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    startIssue(llm, b.id);
    completeIssue(llm, b.id, { summary: "やった" });
    const rejected = rejectReview(me, b.id, "テストが足りない");
    expect(rejected).toMatchObject({ status: "in_progress", agentState: null });
    expect(eventsOf(db, b.id).at(-1)).toMatchObject({ type: "review_rejected", data: { reason: "テストが足りない" } });
    expect(getIssue(db, b.id).activity.filter((a) => a.kind === "comment").at(-1)).toMatchObject({ body: "テストが足りない" });
  });

  test("approve を LLM が実行すると FORBIDDEN_FOR_LLM になり、Issue は変わらない", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    startIssue(llm, a.id);
    completeIssue(llm, a.id, { summary: "やった" });
    expect(codeOf(() => approveReview(llm, a.id))).toBe("FORBIDDEN_FOR_LLM");
    expect(getIssue(db, a.id).status).toBe("in_review");
  });
});

describe("listTriage", () => {
  test("全 Workspace の Triage を作成順に返し、Snooze の期限が来ていないものは除く", () => {
    const { db, ws, me, llm } = setup();
    const web = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    const a = createIssue(llm, { workspaceId: ws.id, title: "a" });
    const b = createIssue(llm, { workspaceId: web.id, title: "b" });
    const later = createIssue(llm, { workspaceId: ws.id, title: "later" });
    const expired = createIssue(llm, { workspaceId: ws.id, title: "expired" });
    const accepted = createIssue(llm, { workspaceId: ws.id, title: "accepted" });
    snoozeTriage(me, later.id, "2099-01-01");
    snoozeTriage(me, expired.id, "2000-01-01");
    acceptTriage(me, accepted.id);
    expect(listTriage(db).map((i) => i.id)).toEqual([a.id, b.id, expired.id]);
  });
});

for (const actor of ["codex", "claude-code", "other-agent"]) {
  for (const op of ["accept", "decline", "duplicate"] as const) {
    test(`${actor} の triage ${op} は書き込みなしで拒否する`, () => {
      const { db, ws, me, llm } = setup();
      const original = createIssue(me, { workspaceId: ws.id, title: "元の Issue" });
      const issue = createIssue(llm, { workspaceId: ws.id, title: "判断待ち", labels: ["bug"] });
      const before = getIssue(db, issue.id);
      const originalBefore = getIssue(db, original.id);
      const changes = db.query("SELECT total_changes() AS n").get();
      const ctx = { ...llm, actor };
      expect(codeOf(() => {
        if (op === "accept") acceptTriage(ctx, issue.id);
        else if (op === "decline") declineTriage(ctx, issue.id, "不要");
        else duplicateTriage(ctx, issue.id, original.id);
      })).toBe("FORBIDDEN_FOR_LLM");
      expect(db.query("SELECT total_changes() AS n").get()).toEqual(changes);
      expect(getIssue(db, issue.id)).toEqual(before);
      expect(getIssue(db, original.id)).toEqual(originalBefore);
    });
  }
}

test("回答eventの書き手と再開する作業主体を分け、後の担当変更でも履歴を保つ", () => {
  const { db, ws, me, llm } = setup();
  const codex = { ...llm, actor: "codex" };
  const issue = createIssue(me, { workspaceId: ws.id, title: "回答待ち" });
  startIssue(codex, issue.id);
  const first = askQuestion(codex, issue.id, "方針は？");
  const second = askQuestion(codex, issue.id, "期限は？");
  const count = () => eventsOf(db, issue.id).filter((e) => e.type === "agent_state_changed").length;
  const before = count();
  answerQuestion(me, issue.id, "進める", { questionId: first.question.id });
  expect(count()).toBe(before);
  answerQuestion(me, issue.id, "明日", { questionId: second.question.id });
  expect(count()).toBe(before + 1);
  const resumed = eventsOf(db, issue.id).at(-1);
  expect(resumed).toMatchObject({ actor: "me", type: "agent_state_changed", data: { from: "awaiting_input", to: "working", agent: "codex", trigger: "answer" } });
  updateIssue(me, issue.id, { assignee: "claude-code" });
  expect(eventsOf(db, issue.id).filter((e) => e.type === "agent_state_changed").at(-1)).toEqual(resumed);
  expect(eventsOf(db, issue.id).find((e) => e.type === "status_changed")?.data).toEqual({ from: "todo", to: "in_progress" });
});

test("担当者不明の再開eventはagent=nullを記録する", () => {
  const { db, ws, me, llm } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "担当未設定" });
  startIssue(llm, issue.id);
  askQuestion(llm, issue.id, "どうするか");
  updateIssue(me, issue.id, { assignee: null });
  answerQuestion(me, issue.id, "進める");
  expect(eventsOf(db, issue.id).at(-1)).toMatchObject({ actor: "me", data: { agent: null, trigger: "answer" } });
});
