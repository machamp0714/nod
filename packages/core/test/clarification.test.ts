import { describe, expect, test } from "bun:test";
import { askQuestion, nextIssue, startIssue } from "../src/ops/agent";
import { acceptTriage, answerQuestion, getInbox } from "../src/ops/human";
import { createIssue, getIssue, updateIssue } from "../src/ops/issues";
import { codeOf, eventsOf, setup } from "./helpers";

const statusChanges = (db: Parameters<typeof eventsOf>[0], ref: string) =>
  eventsOf(db, ref)
    .filter((e) => e.type === "status_changed")
    .map((e) => e.data);

describe("Needs Clarification への自動の切り替え", () => {
  test("todo の Issue に未決事項を足すと needs_clarification になり、すべて決めると todo に戻る", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const first = askQuestion(me, i.id, "対象の画面はどれか");
    const second = askQuestion(me, i.id, "期限はいつか");
    expect(first.issue).toMatchObject({ status: "needs_clarification", agentState: null });
    answerQuestion(me, i.id, "一覧", { questionId: first.question.id });
    expect(getIssue(db, i.id).status).toBe("needs_clarification");
    const r = answerQuestion(me, i.id, "来週", { questionId: second.question.id });
    expect(r.issue.status).toBe("todo");
    expect(statusChanges(db, i.id)).toEqual([
      { from: "todo", to: "needs_clarification" },
      { from: "needs_clarification", to: "todo" },
    ]);
    expect(getIssue(db, i.id).questions.map((q) => [q.question, q.answer])).toEqual([
      ["対象の画面はどれか", "一覧"],
      ["期限はいつか", "来週"],
    ]);
  });

  test("backlog から入った Issue は backlog に戻る", () => {
    const { ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    updateIssue(me, i.id, { status: "backlog" });
    const asked = askQuestion(me, i.id, "やるかどうか");
    expect(asked.issue.status).toBe("needs_clarification");
    expect(answerQuestion(me, i.id, "やる", { questionId: asked.question.id }).issue.status).toBe("backlog");
  });

  test("LLM が todo の Issue に確認を求めても needs_clarification にし、作業状況は変えない", () => {
    const { ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    expect(askQuestion(llm, i.id, "どちらの方式にするか").issue).toMatchObject({
      status: "needs_clarification",
      agentState: null,
    });
  });

  test("未決事項のある Triage の Issue は Triage のままで、受け入れると needs_clarification、決めると todo になる", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(llm, { workspaceId: ws.id, title: "t" });
    const asked = askQuestion(me, i.id, "本当に要るか");
    expect(asked.issue.status).toBe("triage");
    expect(acceptTriage(me, i.id).status).toBe("needs_clarification");
    expect(answerQuestion(me, i.id, "要る", { questionId: asked.question.id }).issue.status).toBe("todo");
    expect(statusChanges(db, i.id)).toEqual([
      { from: "triage", to: "todo" },
      { from: "todo", to: "needs_clarification" },
      { from: "needs_clarification", to: "todo" },
    ]);
  });

  test("needs_clarification の間に手で backlog に移すと、決めたときに backlog に戻る", () => {
    const { ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const asked = askQuestion(me, i.id, "対象はどれか");
    expect(updateIssue(me, i.id, { status: "in_progress" }).status).toBe("in_progress");
    expect(updateIssue(me, i.id, { status: "backlog" }).status).toBe("needs_clarification");
    expect(answerQuestion(me, i.id, "一覧", { questionId: asked.question.id }).issue.status).toBe("backlog");
  });

  test("in_progress の Issue では、LLM の確認依頼は作業状況を awaiting_input にし、私の確認依頼は何も変えない", () => {
    const { ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    startIssue(llm, i.id);
    expect(askQuestion(me, i.id, "ついでに直すか").issue).toMatchObject({ status: "in_progress", agentState: "working" });
    expect(askQuestion(llm, i.id, "--force を外してよいか").issue).toMatchObject({
      status: "in_progress",
      agentState: "awaiting_input",
    });
  });

  test("needs_clarification の Issue は next で取られず、start は NEEDS_CLARIFICATION になる", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    askQuestion(me, i.id, "対象はどれか");
    expect(nextIssue(llm, { workspaceId: ws.id })).toBeNull();
    expect(codeOf(() => startIssue(llm, i.id))).toBe("NEEDS_CLARIFICATION");
    expect(getIssue(db, i.id).status).toBe("needs_clarification");
  });

  test("同じ文面の未決事項は増やさず、ステータスもそのまま", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    askQuestion(me, i.id, "対象はどれか");
    const again = askQuestion(me, i.id, "対象はどれか");
    expect(again).toMatchObject({ created: false, issue: { status: "needs_clarification" } });
    expect(eventsOf(db, i.id).filter((e) => e.type === "question_asked")).toHaveLength(1);
    expect(statusChanges(db, i.id)).toHaveLength(1);
  });
});

describe("answerQuestion の対象", () => {
  test("既定では LLM の質問だけに答え、私の未決事項は残す", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    startIssue(llm, i.id);
    askQuestion(me, i.id, "私の未決事項");
    askQuestion(llm, i.id, "LLM の質問");
    const r = answerQuestion(me, i.id, "よい");
    expect(r.answered.map((q) => q.question)).toEqual(["LLM の質問"]);
    expect(r.issue.agentState).toBe("working");
    expect(getIssue(db, i.id).openQuestions.map((q) => q.question)).toEqual(["私の未決事項"]);
  });

  test("LLM の質問がなく私の未決事項だけなら NO_OPEN_QUESTION で --question を案内し、何も変えない", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    askQuestion(me, i.id, "対象はどれか");
    let message = "";
    try {
      answerQuestion(me, i.id, "一覧");
    } catch (e) {
      expect((e as { code: string }).code).toBe("NO_OPEN_QUESTION");
      message = (e as Error).message;
    }
    expect(message).toContain("--question");
    const detail = getIssue(db, i.id);
    expect(detail.status).toBe("needs_clarification");
    expect(detail.openQuestions).toHaveLength(1);
  });

  test("--question は指定した質問だけに答え、別の Issue の質問は NOT_FOUND、回答済みは NO_OPEN_QUESTION", () => {
    const { ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    const qa = askQuestion(me, a.id, "a の質問").question;
    const qb = askQuestion(me, b.id, "b の質問").question;
    expect(codeOf(() => answerQuestion(me, a.id, "x", { questionId: qb.id }))).toBe("NOT_FOUND");
    expect(answerQuestion(me, a.id, "決めた", { questionId: qa.id }).answered).toEqual([
      expect.objectContaining({ id: qa.id, answer: "決めた", answeredBy: "me" }),
    ]);
    expect(codeOf(() => answerQuestion(me, a.id, "もう一度", { questionId: qa.id }))).toBe("NO_OPEN_QUESTION");
  });

  test("LLM の質問が残っている間は awaiting_input のまま", () => {
    const { ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    startIssue(llm, i.id);
    const q1 = askQuestion(llm, i.id, "一つ目").question;
    const q2 = askQuestion(llm, i.id, "二つ目").question;
    expect(answerQuestion(me, i.id, "よい", { questionId: q1.id }).issue.agentState).toBe("awaiting_input");
    expect(answerQuestion(me, i.id, "よい", { questionId: q2.id }).issue.agentState).toBe("working");
  });
});

describe("人が付けた未決事項への LLM の回答（#172）", () => {
  const messageOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };

  test("LLM は me が付けた未決事項に --question で回答できず、何も書き込まない", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const q = askQuestion(me, i.id, "対象はどれか").question;
    const before = getIssue(db, i.id);
    const events = eventsOf(db, i.id);
    expect(codeOf(() => answerQuestion(llm, i.id, "一覧", { questionId: q.id }))).toBe("FORBIDDEN_FOR_LLM");
    expect(messageOf(() => answerQuestion(llm, i.id, "一覧", { questionId: q.id }))).toBe(
      `LLM は me が付けた未決事項（質問 ${q.id}）に回答できません。回答は me に依頼してください`,
    );
    expect(getIssue(db, i.id)).toEqual(before);
    expect(eventsOf(db, i.id)).toEqual(events);
    expect(before.status).toBe("needs_clarification");
    expect(nextIssue(llm, { workspaceId: ws.id })).toBeNull();
    // 人は従来どおり回答でき、Todo に戻る
    expect(answerQuestion(me, i.id, "一覧", { questionId: q.id }).issue.status).toBe("todo");
  });

  test("me の未決事項は、回答済みでも LLM には FORBIDDEN_FOR_LLM を返し、回答を書き換えない", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const q = askQuestion(me, i.id, "対象はどれか").question;
    answerQuestion(me, i.id, "一覧", { questionId: q.id });
    expect(codeOf(() => answerQuestion(llm, i.id, "詳細", { questionId: q.id }))).toBe("FORBIDDEN_FOR_LLM");
    expect(getIssue(db, i.id).questions).toEqual([expect.objectContaining({ answer: "一覧", answeredBy: "me" })]);
  });

  test("存在しない質問は LLM にも NOT_FOUND を返す", () => {
    const { ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    const qb = askQuestion(me, b.id, "b の質問").question;
    expect(codeOf(() => answerQuestion(llm, a.id, "x", { questionId: qb.id }))).toBe("NOT_FOUND");
  });

  test("LLM が付けた質問には、LLM が --question でもまとめてでも従来どおり回答できる", () => {
    const { db, ws, me, llm } = setup();
    const other = { db, actor: "codex" };
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    startIssue(llm, i.id);
    const q1 = askQuestion(llm, i.id, "一つ目").question;
    askQuestion(llm, i.id, "二つ目");
    expect(answerQuestion(other, i.id, "よい", { questionId: q1.id }).answered).toEqual([
      expect.objectContaining({ id: q1.id, answeredBy: "codex" }),
    ]);
    expect(answerQuestion(llm, i.id, "よい").issue.agentState).toBe("working");
  });

  test("LLM のまとめての回答は me の未決事項を閉じず、me の未決事項だけなら --question へ誘導しない", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    askQuestion(me, i.id, "私の未決事項");
    askQuestion(llm, i.id, "LLM の質問");
    expect(answerQuestion(llm, i.id, "よい").answered.map((q) => q.question)).toEqual(["LLM の質問"]);
    expect(getIssue(db, i.id)).toMatchObject({ status: "needs_clarification", openQuestions: [{ question: "私の未決事項" }] });
    expect(codeOf(() => answerQuestion(llm, i.id, "よい"))).toBe("NO_OPEN_QUESTION");
    const message = messageOf(() => answerQuestion(llm, i.id, "よい"));
    expect(message).toContain("未決事項（1 件）は me が決めます");
    expect(message).not.toContain("--question");
  });

  test("すでに LLM が回答した me の未決事項は、そのまま残る", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const q = askQuestion(me, i.id, "対象はどれか").question;
    // ガードを入れる前に LLM が回答した行を再現する
    db.query("UPDATE questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?").run("一覧", "claude-code", "2026-09-30T00:00:00.000Z", q.id);
    expect(getIssue(db, i.id).questions).toEqual([expect.objectContaining({ answer: "一覧", answeredBy: "claude-code" })]);
    expect(codeOf(() => answerQuestion(llm, i.id, "詳細", { questionId: q.id }))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => answerQuestion(me, i.id, "詳細", { questionId: q.id }))).toBe("NO_OPEN_QUESTION");
    expect(getIssue(db, i.id).questions).toEqual([expect.objectContaining({ answer: "一覧", answeredBy: "claude-code" })]);
  });
});

describe("getInbox", () => {
  test("私が足した未決事項は Inbox に出さない", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    startIssue(llm, i.id);
    askQuestion(me, i.id, "私の未決事項");
    askQuestion(llm, i.id, "LLM の質問");
    expect(getInbox(db).questions.map((q) => q.question)).toEqual(["LLM の質問"]);
  });
});

test("安全な整数を超える質問 ID は INVALID_ARGS で、回答を変更しない", () => {
  const { db, ws, me } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "質問 ID の検証" });
  askQuestion(me, issue.id, "対象は");
  const before = getIssue(db, issue.id);
  expect(codeOf(() => answerQuestion(me, issue.id, "回答", { questionId: Number.MAX_SAFE_INTEGER + 1 }))).toBe("INVALID_ARGS");
  expect(getIssue(db, issue.id)).toEqual(before);
});
