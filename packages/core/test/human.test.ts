import { describe, expect, test } from "bun:test";
import { askQuestion, completeIssue, startIssue } from "../src/ops/agent";
import {
  acceptTriage,
  answerQuestion,
  declineTriage,
  duplicateTriage,
  getInbox,
  listTriage,
  parseDateTime,
  snoozeTriage,
} from "../src/ops/human";
import { createIssue, getIssue, updateIssue } from "../src/ops/issues";
import { initWorkspace } from "../src/ops/workspaces";
import { codeOf, eventsOf, setup } from "./helpers";

describe("getInbox と answerQuestion", () => {
  test("全 Workspace の未回答の確認依頼を集め、回答で消える", () => {
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
    expect(inbox).not.toHaveProperty("reviews");

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

  test("acceptの旧Cycle直接所属は固定値も解除も相対指定も拒否し、Triageと履歴を変えない", () => {
    const {db,ws,me,llm}=setup();
    const issue=createIssue(llm,{workspaceId:ws.id,title:"元のTriage"});
    const before=getIssue(db,issue.id);
    const events=eventsOf(db,issue.id);
    for (const cycleRef of ["1","旧名","current",null]) {
      expect(codeOf(()=>acceptTriage(me,issue.id,{cycleRef}))).toBe("CYCLE_RETIRED");
      expect(getIssue(db,issue.id)).toEqual(before);
      expect(eventsOf(db,issue.id)).toEqual(events);
    }
    expect(acceptTriage(me,issue.id).status).toBe("todo");
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
    test(`${actor} も triage ${op} で判断でき、event の書き手に残る`, () => {
      const { db, ws, me, llm } = setup();
      const original = createIssue(me, { workspaceId: ws.id, title: "元の Issue" });
      const issue = createIssue(llm, { workspaceId: ws.id, title: "判断待ち", labels: ["bug"] });
      const ctx = { ...llm, actor };
      const decided =
        op === "accept" ? acceptTriage(ctx, issue.id)
        : op === "decline" ? declineTriage(ctx, issue.id, "不要")
        : duplicateTriage(ctx, issue.id, original.id);
      expect(decided.status).toBe(op === "accept" ? "todo" : "canceled");
      expect(eventsOf(db, issue.id).find((e) => e.type === (op === "accept" ? "triage_accepted" : "triage_declined"))?.actor).toBe(actor);
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
