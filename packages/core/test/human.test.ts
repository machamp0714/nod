import { describe, expect, test } from "bun:test";
import { askQuestion, completeIssue, startIssue } from "../src/ops/agent";
import {
  acceptTriage,
  answerQuestion,
  approveReview,
  declineTriage,
  duplicateTriage,
  getInbox,
  parseDateTime,
  rejectReview,
  snoozeTriage,
} from "../src/ops/human";
import { createIssue, getIssue } from "../src/ops/issues";
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
});

describe("Triage", () => {
  test("accept は todo にし、Triage にない Issue は NOT_IN_TRIAGE", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(llm, { workspaceId: ws.id, title: "t" });
    expect(acceptTriage(me, i.id).status).toBe("todo");
    expect(eventsOf(db, i.id).at(-1)?.type).toBe("triage_accepted");
    expect(codeOf(() => acceptTriage(me, i.id))).toBe("NOT_IN_TRIAGE");
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
    expect(codeOf(() => parseDateTime("+3d"))).toBe("INVALID_ARGS");
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
