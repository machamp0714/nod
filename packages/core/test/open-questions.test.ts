import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { askQuestion, startIssue } from "../src/ops/agent";
import { answerQuestion } from "../src/ops/human";
import { archiveIssue, createIssue, updateIssue } from "../src/ops/issues";
import { listOpenQuestions, openQuestionsQueryFromParams } from "../src/ops/open-questions";
import { createProject } from "../src/ops/projects";
import { initWorkspace } from "../src/ops/workspaces";
import { codeOf, setup } from "./helpers";

function askedAt(db: Database, questionId: number, at: string): void {
  db.query("UPDATE questions SET asked_at = ? WHERE id = ?").run(at, questionId);
}

describe("listOpenQuestions", () => {
  test("全 Workspace の未回答の未決事項を、人が付けたものも含めて Issue の情報つきで返す", () => {
    const { db, ws, me, llm } = setup();
    const web = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    const project = createProject(me, { name: "調査票" });
    const a = createIssue(me, { workspaceId: ws.id, title: "設問を決める", projectRef: project.name, priority: 2 });
    const b = createIssue(me, { workspaceId: web.id, title: "画面" });
    const q1 = askQuestion(me, a.id, "Q3 は必須にするか").question;
    const q2 = askQuestion(me, a.id, "回答期限はいつか").question;
    answerQuestion(me, a.id, "必須にする", { questionId: q1.id });
    startIssue(llm, b.id);
    const q3 = askQuestion(llm, b.id, "色は変えてよいか").question;

    const r = listOpenQuestions(db);
    expect(r).toMatchObject({ total: 2, issueCount: 2, more: 0 });
    expect(r.questions).toEqual([
      {
        ...q2,
        issueTitle: "設問を決める",
        workspace: "API",
        status: "needs_clarification",
        priority: 2,
        project: { id: project.id, name: "調査票" },
        questionCount: { answered: 1, total: 2 },
      },
      {
        ...q3,
        issueTitle: "画面",
        workspace: "WEB",
        status: "in_progress",
        priority: 0,
        project: null,
        questionCount: { answered: 0, total: 1 },
      },
    ]);
  });

  test("needs_clarification でない Issue に人が足した未決事項も出し、完了・キャンセル・アーカイブ済みは出さない", () => {
    const { db, ws, me, llm } = setup();
    const doing = createIssue(me, { workspaceId: ws.id, title: "作業中" });
    const done = createIssue(me, { workspaceId: ws.id, title: "完了" });
    const canceled = createIssue(me, { workspaceId: ws.id, title: "キャンセル" });
    const archived = createIssue(me, { workspaceId: ws.id, title: "アーカイブ" });
    startIssue(llm, doing.id);
    startIssue(llm, done.id);
    for (const issue of [doing, done, canceled, archived]) askQuestion(me, issue.id, `${issue.title} の未決事項`);
    updateIssue(me, done.id, { status: "done" });
    updateIssue(me, canceled.id, { status: "canceled" });
    archiveIssue(me, archived.id);

    const r = listOpenQuestions(db);
    expect(r.questions.map((q) => [q.issueId, q.status])).toEqual([[doing.id, "in_progress"]]);
    expect(r.total).toBe(1);
  });

  test("質問者で絞る（me は人、llm は人以外）", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    startIssue(llm, i.id);
    askQuestion(me, i.id, "人の未決事項");
    askQuestion(llm, i.id, "LLM の質問");
    expect(listOpenQuestions(db, { askedBy: "me" }).questions.map((q) => q.question)).toEqual(["人の未決事項"]);
    expect(listOpenQuestions(db, { askedBy: "llm" }).questions.map((q) => q.question)).toEqual(["LLM の質問"]);
    expect(listOpenQuestions(db).questions.map((q) => q.question)).toEqual(["人の未決事項", "LLM の質問"]);
    // 件数は質問者で絞った後のもの。Issue の決定数 / 総数は絞り込みに左右されない
    expect(listOpenQuestions(db, { askedBy: "me" })).toMatchObject({ total: 1, issueCount: 1 });
    expect(listOpenQuestions(db, { askedBy: "me" }).questions[0]!.questionCount).toEqual({ answered: 0, total: 2 });
  });

  test("Workspace・Project・ステータス・検索で絞る", () => {
    const { db, ws, me, llm } = setup();
    const web = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    const project = createProject(me, { name: "調査票" });
    const a = createIssue(me, { workspaceId: ws.id, title: "設問を決める", projectRef: project.name });
    const b = createIssue(me, { workspaceId: web.id, title: "画面の配色" });
    const c = createIssue(me, { workspaceId: ws.id, title: "作業中のもの" });
    startIssue(llm, c.id);
    askQuestion(me, a.id, "Q3 は必須にするか");
    askQuestion(me, b.id, "ボタンの色");
    askQuestion(me, c.id, "締め切り");
    const ids = (q: Parameters<typeof listOpenQuestions>[1]) => listOpenQuestions(db, q).questions.map((x) => x.issueId);

    expect(ids({ workspace: ["WEB"] })).toEqual([b.id]);
    expect(ids({ workspace: ["api", "WEB"] }).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(ids({ project: "調査票" })).toEqual([a.id]);
    expect(ids({ project: String(project.id) })).toEqual([a.id]);
    expect(ids({ status: ["in_progress"] })).toEqual([c.id]);
    expect(ids({ status: ["needs_clarification"] }).sort()).toEqual([a.id, b.id].sort());
    // 検索は質問文・Issue のタイトル・ID のどれかに合うもの（大文字小文字を区別しない）
    expect(ids({ q: "q3" })).toEqual([a.id]);
    expect(ids({ q: "配色" })).toEqual([b.id]);
    expect(ids({ q: b.id.toLowerCase() })).toEqual([b.id]);
    expect(ids({ q: "どれにも合わない" })).toEqual([]);

    expect(codeOf(() => listOpenQuestions(db, { workspace: ["NOPE"] }))).toBe("NOT_FOUND");
    expect(codeOf(() => listOpenQuestions(db, { project: "ない" }))).toBe("NOT_FOUND");
    expect(codeOf(() => listOpenQuestions(db, { status: ["done"] }))).toBe("INVALID_ARGS");
  });

  test("Issue の優先度、最古の未回答の質問の古い順、ID の順に並べ、Issue の中は質問の id 順にする", () => {
    const { db, ws, me } = setup();
    const none = createIssue(me, { workspaceId: ws.id, title: "優先度なし" });
    const low = createIssue(me, { workspaceId: ws.id, title: "Low", priority: 4 });
    const urgentNew = createIssue(me, { workspaceId: ws.id, title: "Urgent 新しい", priority: 1 });
    const urgentOld = createIssue(me, { workspaceId: ws.id, title: "Urgent 古い", priority: 1 });
    const stamp = (issueId: string, text: string, at: string) => askedAt(db, askQuestion(me, issueId, text).question.id, at);
    stamp(none.id, "n1", "2026-09-01T00:00:00.000Z");
    stamp(low.id, "l1", "2026-09-02T00:00:00.000Z");
    stamp(urgentNew.id, "un1", "2026-09-20T00:00:00.000Z");
    stamp(urgentOld.id, "uo1", "2026-09-25T00:00:00.000Z");
    stamp(urgentOld.id, "uo2", "2026-09-10T00:00:00.000Z");

    expect(listOpenQuestions(db).questions.map((q) => q.question)).toEqual(["uo1", "uo2", "un1", "l1", "n1"]);
  });

  test("limit は Issue の数で切り、件数は切る前のものを返す", () => {
    const { db, ws, me } = setup();
    for (let n = 1; n <= 3; n++) {
      const issue = createIssue(me, { workspaceId: ws.id, title: `Issue ${n}` });
      askQuestion(me, issue.id, `${n}-a`);
      askQuestion(me, issue.id, `${n}-b`);
    }
    const r = listOpenQuestions(db, { limit: 2 });
    expect(r).toMatchObject({ total: 6, issueCount: 3, more: 1 });
    expect(r.questions.map((q) => q.question)).toEqual(["1-a", "1-b", "2-a", "2-b"]);
    expect(codeOf(() => listOpenQuestions(db, { limit: 0 }))).toBe("INVALID_ARGS");
    expect(codeOf(() => listOpenQuestions(db, { limit: 1.5 }))).toBe("INVALID_ARGS");
  });
});

describe("openQuestionsQueryFromParams", () => {
  const parse = (query: string) => openQuestionsQueryFromParams(new URLSearchParams(query));

  test("クエリパラメータを絞り込み条件にする", () => {
    expect(parse("")).toEqual({});
    expect(parse("askedBy=me&workspace=api,web&workspace=TS&project=3&status=todo,in_progress&q=%E8%89%B2&limit=20")).toEqual({
      askedBy: "me",
      workspace: ["api", "web", "TS"],
      project: "3",
      status: ["todo", "in_progress"],
      q: "色",
      limit: 20,
    });
  });

  test("知らないキーと不正な値は INVALID_ARGS", () => {
    expect(codeOf(() => parse("asked=me"))).toBe("INVALID_ARGS");
    expect(codeOf(() => parse("askedBy=claude-code"))).toBe("INVALID_ARGS");
    expect(codeOf(() => parse("status=unknown"))).toBe("INVALID_ARGS");
    expect(codeOf(() => parse("limit=abc"))).toBe("INVALID_ARGS");
    expect(codeOf(() => parse("project=1&project=2"))).toBe("INVALID_ARGS");
  });
});
