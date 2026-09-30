import { describe, expect, test } from "bun:test";
import { askQuestion, createIssue, initWorkspace, listOpenQuestions, startIssue } from "@nod/core";
import { call, setup } from "./helpers";

describe("GET /api/open-questions", () => {
  // API-1: me の未決事項 2 件（needs_clarification）、API-2: LLM の質問 1 件（in_progress）、WEB-1: me の未決事項 1 件
  function seed() {
    const s = setup();
    const web = initWorkspace(s.db, { path: "/tmp/repos/web" }).workspace;
    const a = createIssue(s.me, { workspaceId: s.ws.id, title: "設問を決める" });
    const b = createIssue(s.me, { workspaceId: s.ws.id, title: "検索" });
    const c = createIssue(s.me, { workspaceId: web.id, title: "画面" });
    askQuestion(s.me, a.id, "Q3 は必須にするか");
    askQuestion(s.me, a.id, "回答期限はいつか");
    startIssue(s.llm, b.id);
    askQuestion(s.llm, b.id, "インデックスを足してよいか");
    askQuestion(s.me, c.id, "ボタンの色");
    return s;
  }

  test("未回答の未決事項を core と同じ形で返す", async () => {
    const { app, db } = seed();
    const r = await call(app, "GET", "/api/open-questions");
    expect(r.status).toBe(200);
    expect(r.json).toEqual(JSON.parse(JSON.stringify(listOpenQuestions(db))));
    expect(r.json).toMatchObject({ total: 4, issueCount: 3, more: 0 });
  });

  test("質問者・Workspace・検索・件数で絞る", async () => {
    const { app } = seed();
    const ids = async (query: string) =>
      (await call(app, "GET", `/api/open-questions?${query}`)).json.questions.map((q: { issueId: string }) => q.issueId);
    expect(await ids("askedBy=me")).toEqual(["API-1", "API-1", "WEB-1"]);
    expect(await ids("askedBy=llm")).toEqual(["API-2"]);
    expect(await ids("askedBy=me&workspace=WEB")).toEqual(["WEB-1"]);
    expect(await ids("status=in_progress")).toEqual(["API-2"]);
    expect(await ids(`q=${encodeURIComponent("期限")}`)).toEqual(["API-1"]);
    const limited = await call(app, "GET", "/api/open-questions?limit=1");
    expect(limited.json).toMatchObject({ total: 4, issueCount: 3, more: 2 });
  });

  test("不正な条件は 400、存在しない Workspace は 404", async () => {
    const { app } = seed();
    for (const query of ["askedBy=codex", "limit=0", "status=done", "unknown=1"]) {
      const r = await call(app, "GET", `/api/open-questions?${query}`);
      expect([query, r.status, r.json.error.code]).toEqual([query, 400, "INVALID_ARGS"]);
    }
    expect((await call(app, "GET", "/api/open-questions?workspace=NOPE")).status).toBe(404);
  });

  test("既存の /api/inbox は人が付けた未決事項を含めないまま", async () => {
    const { app } = seed();
    const inbox = await call(app, "GET", "/api/inbox");
    expect(inbox.json.questions.map((q: { issueId: string }) => q.issueId)).toEqual(["API-2"]);
  });
});
