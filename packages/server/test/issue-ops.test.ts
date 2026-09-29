import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { askQuestion, completeIssue, createIssue, startIssue } from "@nod/core";
import { call, setup } from "./helpers";

const actorsOf = (db: Database, type: string) =>
  (db.query("SELECT actor FROM events WHERE type = ? ORDER BY id").all(type) as { actor: string }[]).map((e) => e.actor);

describe("ask と answer", () => {
  test("web から足した未決事項は書き手が me で、todo を needs_clarification にし、作業状況は変えない", async () => {
    const { app, me, ws } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const r = await call(app, "POST", `/api/issues/${i.id}/ask`, { question: "対象の画面はどれか" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      created: true,
      question: { question: "対象の画面はどれか", askedBy: "me", answer: null },
      issue: { status: "needs_clarification", agentState: null },
    });
    const again = await call(app, "POST", `/api/issues/${i.id}/ask`, { question: "対象の画面はどれか" });
    expect(again.json.created).toBe(false);
    expect(again.json.question.id).toBe(r.json.question.id);
  });

  test("questionId でその質問だけに答え、すべて決まれば元のステータスに戻る", async () => {
    const { app, me, ws } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const q1 = askQuestion(me, i.id, "一つ目").question;
    const q2 = askQuestion(me, i.id, "二つ目").question;
    const first = await call(app, "POST", `/api/issues/${i.id}/answer`, { answer: "A", questionId: q1.id });
    expect(first.status).toBe(200);
    expect(first.json.answered.map((q: { id: number }) => q.id)).toEqual([q1.id]);
    expect(first.json.issue.status).toBe("needs_clarification");
    const second = await call(app, "POST", `/api/issues/${i.id}/answer`, { answer: "B", questionId: q2.id });
    expect(second.json.issue.status).toBe("todo");
    const done = await call(app, "POST", `/api/issues/${i.id}/answer`, { answer: "C", questionId: q2.id });
    expect(done.status).toBe(409);
    expect(done.json.error.code).toBe("NO_OPEN_QUESTION");
  });

  test("questionId なしの回答は LLM の質問にまとめて答え、作業状況を working に戻す", async () => {
    const { app, db, me, llm, ws } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    startIssue(llm, i.id);
    askQuestion(llm, i.id, "A と B のどちらか");
    const r = await call(app, "POST", `/api/issues/${i.id}/answer`, { answer: "A" });
    expect(r.status).toBe(200);
    expect(r.json.issue.agentState).toBe("working");
    expect(r.json.answered.map((q: { answeredBy: string }) => q.answeredBy)).toEqual(["me"]);
    expect(actorsOf(db, "question_answered")).toEqual(["me"]);
  });

  test("私の未決事項だけが残る Issue への questionId なしの回答は 409 で、未決事項を閉じない", async () => {
    const { app, me, ws } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    askQuestion(me, i.id, "私の未決事項");
    const r = await call(app, "POST", `/api/issues/${i.id}/answer`, { answer: "x" });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("NO_OPEN_QUESTION");
    expect((await call(app, "GET", `/api/issues/${i.id}`)).json.status).toBe("needs_clarification");
  });
});

describe("Triage とレビュー", () => {
  test("accept、decline、duplicate、snooze は書き手 me で記録する", async () => {
    const { app, db, llm, ws } = setup();
    const a = createIssue(llm, { workspaceId: ws.id, title: "a" });
    const b = createIssue(llm, { workspaceId: ws.id, title: "b" });
    const c = createIssue(llm, { workspaceId: ws.id, title: "c" });
    const d = createIssue(llm, { workspaceId: ws.id, title: "d" });
    expect((await call(app, "POST", `/api/issues/${a.id}/accept`)).json.status).toBe("todo");
    expect((await call(app, "POST", `/api/issues/${b.id}/decline`, { reason: "不要" })).json).toMatchObject({
      status: "canceled",
      closeReason: "不要",
    });
    expect((await call(app, "POST", `/api/issues/${c.id}/duplicate`, { original: a.id })).json.status).toBe("canceled");
    const snoozed = await call(app, "POST", `/api/issues/${d.id}/snooze`, { until: "2999-01-01" });
    expect(snoozed.json).toMatchObject({ status: "triage" });
    expect(snoozed.json.snoozedUntil).not.toBeNull();
    expect(actorsOf(db, "triage_accepted")).toEqual(["me"]);
    expect(actorsOf(db, "triage_declined")).toEqual(["me", "me"]);
  });

  test("Triage にない Issue の受け入れは 409 で、今の状態をメッセージに示す。誤った日時は 400", async () => {
    const { app, me, llm, ws } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const r = await call(app, "POST", `/api/issues/${i.id}/accept`, {});
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("NOT_IN_TRIAGE");
    expect(r.json.error.message).toContain("todo");
    const t = createIssue(llm, { workspaceId: ws.id, title: "t" });
    expect((await call(app, "POST", `/api/issues/${t.id}/snooze`, { until: "来週" })).status).toBe(400);
  });

  test("approve は done、reject は理由をコメントに残して in_progress に戻す", async () => {
    const { app, db, me, llm, ws } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    for (const i of [a, b]) {
      startIssue(llm, i.id);
      completeIssue(llm, i.id, { summary: "やった" });
    }
    expect((await call(app, "POST", `/api/issues/${a.id}/approve`)).json.status).toBe("done");
    expect(actorsOf(db, "review_approved")).toEqual(["me"]);
    const rejected = await call(app, "POST", `/api/issues/${b.id}/reject`, { reason: "テストが足りない" });
    expect(rejected.json).toMatchObject({ status: "in_progress", agentState: null });
    expect((await call(app, "POST", `/api/issues/${a.id}/approve`)).json.error.code).toBe("NOT_IN_REVIEW");
    expect((await call(app, "POST", `/api/issues/${b.id}/reject`, {})).status).toBe(400);
  });
});

describe("update と comment", () => {
  test("update は渡した項目だけを変える", async () => {
    const { app, me, ws } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t", description: "説明" });
    const r = await call(app, "POST", `/api/issues/${i.id}/update`, {
      title: "新しい題",
      priority: 2,
      status: "backlog",
      addLabels: ["bug"],
      assignee: null,
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ title: "新しい題", priority: 2, status: "backlog", labels: ["bug"], description: "説明" });
  });

  test("comment は書き手 me のコメントを 201 で返す", async () => {
    const { app, me, ws } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const r = await call(app, "POST", `/api/issues/${i.id}/comment`, { body: "確認しました" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ issueId: "API-1", author: "me", body: "確認しました" });
  });
});

describe("コメントのスレッド", () => {
  test("parentId で返信し、他 Issue・存在しない親への返信は拒否する", async () => {
    const { app, me, ws } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    const root = (await call(app, "POST", `/api/issues/${a.id}/comment`, { body: "親" })).json;
    const reply = await call(app, "POST", `/api/issues/${a.id}/comment`, { body: "返信", parentId: root.id });
    expect(reply.status).toBe(201);
    expect(reply.json).toMatchObject({ parentId: root.id, author: "me" });
    const detail = (await call(app, "GET", `/api/issues/${a.id}`)).json;
    const thread = detail.activity.find((x: { kind: string }) => x.kind === "comment");
    expect(thread).toMatchObject({ id: root.id, replies: [{ id: reply.json.id, body: "返信" }] });
    const other = await call(app, "POST", `/api/issues/${b.id}/comment`, { body: "x", parentId: root.id });
    expect([other.status, other.json.error.code]).toEqual([400, "INVALID_ARGS"]);
    const missing = await call(app, "POST", `/api/issues/${a.id}/comment`, { body: "x", parentId: 9999 });
    expect([missing.status, missing.json.error.code]).toEqual([404, "NOT_FOUND"]);
    const badType = await call(app, "POST", `/api/issues/${a.id}/comment`, { body: "x", parentId: "1" });
    expect([badType.status, badType.json.error.code]).toEqual([400, "INVALID_ARGS"]);
  });
});

describe("スレッドの解決", () => {
  test("resolve-thread で解決・未解決を切り替え、型の誤りと存在しないコメントは拒否する（Web の書き手は常に me。LLM の拒否は core の comment-threads.test.ts で確かめる）", async () => {
    const { app, me, ws } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const root = (await call(app, "POST", `/api/issues/${i.id}/comment`, { body: "親" })).json;
    const r = await call(app, "POST", `/api/issues/${i.id}/resolve-thread`, { commentId: root.id, resolved: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: root.id, resolvedBy: "me" });
    const thread = (await call(app, "GET", `/api/issues/${i.id}`)).json.activity.find((x: { kind: string }) => x.kind === "comment");
    expect(thread.resolvedBy).toBe("me");
    const reopened = await call(app, "POST", `/api/issues/${i.id}/resolve-thread`, { commentId: root.id, resolved: false });
    expect(reopened.json).toMatchObject({ resolvedAt: null, resolvedBy: null });
    for (const body of [{}, { commentId: root.id }, { commentId: "1", resolved: true }, { commentId: root.id, resolved: "yes" }]) {
      const bad = await call(app, "POST", `/api/issues/${i.id}/resolve-thread`, body);
      expect([body, bad.status, bad.json.error.code]).toEqual([body, 400, "INVALID_ARGS"]);
    }
    const missing = await call(app, "POST", `/api/issues/${i.id}/resolve-thread`, { commentId: 9999, resolved: true });
    expect(missing.status).toBe(404);
  });
});

describe("誤った入力", () => {
  test("本文の誤りは 400 の INVALID_ARGS で、Issue を変えない", async () => {
    const { app, me, ws } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const cases: [string, unknown][] = [
      ["update", "{"],
      ["update", "[]"],
      ["update", "null"],
      ["update", { priority: "2" }],
      ["update", { priority: 1.5 }],
      ["update", { status: "wip" }],
      ["update", { status: "needs_clarification" }],
      ["update", { addLabels: "bug" }],
      ["update", { color: "red" }],
      ["comment", {}],
      ["comment", { body: 1 }],
      ["ask", { question: "  " }],
      ["answer", { answer: "x", questionId: "1" }],
      ["accept", { force: true }],
    ];
    for (const [op, body] of cases) {
      const r = await call(app, "POST", `/api/issues/${i.id}/${op}`, body);
      expect([op, body, r.status, r.json.error.code]).toEqual([op, body, 400, "INVALID_ARGS"]);
    }
    expect((await call(app, "GET", `/api/issues/${i.id}`)).json).toMatchObject({ status: "todo", priority: 0 });
  });

  test("知らない操作とない Issue は 404。Object のプロパティ名も操作として扱わない", async () => {
    const { app, me, ws } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    for (const op of ["start", "constructor", "toString", "__proto__"]) {
      const r = await call(app, "POST", `/api/issues/${i.id}/${op}`, {});
      expect([op, r.status, r.json.error.code]).toEqual([op, 404, "NOT_FOUND"]);
    }
    expect((await call(app, "POST", "/api/issues/API-99/comment", { body: "x" })).status).toBe(404);
    expect((await call(app, "GET", `/api/issues/${i.id}/comment`)).status).toBe(404);
  });

  test("DB がほかの接続にロックされていたら、busy_timeout の後に 503 の DB_BUSY を返す", async () => {
    const { app, dbPath, me, ws } = setup({ busyTimeoutMs: 50 });
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const other = new Database(dbPath);
    other.exec("BEGIN IMMEDIATE");
    try {
      const r = await call(app, "POST", `/api/issues/${i.id}/comment`, { body: "x" });
      expect(r.status).toBe(503);
      expect(r.json.error.code).toBe("DB_BUSY");
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    expect((await call(app, "POST", `/api/issues/${i.id}/comment`, { body: "x" })).status).toBe(201);
  });
});
