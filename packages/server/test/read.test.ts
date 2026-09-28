import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  askQuestion,
  attachDocument,
  completeIssue,
  createIssue,
  createProject,
  snoozeTriage,
  startIssue,
} from "@nod/core";
import { call, setup, tempDir } from "./helpers";

describe("GET /api/issues", () => {
  // API-1: todo（Ready）、API-2: triage、API-3: needs_clarification（ラベル bug）
  function seed() {
    const s = setup();
    createIssue(s.me, { workspaceId: s.ws.id, title: "a" });
    createIssue(s.llm, { workspaceId: s.ws.id, title: "b" });
    const c = createIssue(s.me, { workspaceId: s.ws.id, title: "c", labels: ["bug"] });
    askQuestion(s.me, c.id, "対象はどれか");
    return s;
  }

  test("条件なしならすべてのステータスの Issue と、Ready と Needs Clarification の件数を返す", async () => {
    const { app } = seed();
    const r = await call(app, "GET", "/api/issues");
    expect(r.status).toBe(200);
    expect(r.json.issues.map((i: { id: string }) => i.id)).toEqual(["API-1", "API-2", "API-3"]);
    expect(r.json.counts).toEqual({ ready: 1, needsClarification: 1 });
    expect(r.json.issues[2].questionCount).toEqual({ answered: 0, total: 1 });
  });

  test("クエリパラメータで絞り込み、件数は Workspace、Project、ラベルの範囲で数える", async () => {
    const { app } = seed();
    const byStatus = await call(app, "GET", "/api/issues?status=todo,triage&workspace=api");
    expect(byStatus.json.issues.map((i: { id: string }) => i.id)).toEqual(["API-1", "API-2"]);
    expect(byStatus.json.counts).toEqual({ ready: 1, needsClarification: 1 });
    const ready = await call(app, "GET", "/api/issues?ready=true");
    expect(ready.json.issues.map((i: { id: string }) => i.id)).toEqual(["API-1"]);
    const label = await call(app, "GET", "/api/issues?label=bug");
    expect(label.json.issues.map((i: { id: string }) => i.id)).toEqual(["API-3"]);
    expect(label.json.counts).toEqual({ ready: 0, needsClarification: 1 });
    const other = await call(app, "GET", "/api/issues?workspace=WEB");
    expect(other.json).toEqual({ issues: [], counts: { ready: 0, needsClarification: 0 } });
  });

  test("誤った条件は 400、ない Project は 404", async () => {
    const { app } = seed();
    expect((await call(app, "GET", "/api/issues?status=wip")).json.error.code).toBe("INVALID_ARGS");
    expect((await call(app, "GET", "/api/issues?ready=yes")).status).toBe(400);
    expect((await call(app, "GET", "/api/issues?sort=title")).status).toBe(400);
    const r = await call(app, "GET", "/api/issues?project=none");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("NOT_FOUND");
  });
});

describe("GET /api/issues/:id", () => {
  test("計画、Documents、質問、Activity を含む詳細を返す", async () => {
    const { app, me, ws } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    askQuestion(me, i.id, "期限はいつか");
    const r = await call(app, "GET", `/api/issues/${i.id}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: "API-1", status: "needs_clarification", plan: { tasks: [] }, documents: [] });
    expect(r.json.questions.map((q: { question: string }) => q.question)).toEqual(["期限はいつか"]);
    expect(r.json.activity.length).toBeGreaterThan(0);
  });

  test("小文字の ID でも引け、ない Issue は 404、形式の違う ID は 400", async () => {
    const { app, me, ws } = setup();
    createIssue(me, { workspaceId: ws.id, title: "t" });
    expect((await call(app, "GET", "/api/issues/api-1")).json.id).toBe("API-1");
    expect((await call(app, "GET", "/api/issues/API-99")).status).toBe(404);
    expect((await call(app, "GET", "/api/issues/nope")).status).toBe(400);
  });
});

describe("GET /api/inbox と GET /api/triage", () => {
  test("Inbox は LLM の未回答の質問とレビュー待ちだけを返す", async () => {
    const { app, me, llm, ws } = setup();
    const asked = createIssue(me, { workspaceId: ws.id, title: "asked" });
    const mine = createIssue(me, { workspaceId: ws.id, title: "mine" });
    const review = createIssue(me, { workspaceId: ws.id, title: "review" });
    startIssue(llm, asked.id);
    askQuestion(llm, asked.id, "どちらの方式にするか");
    askQuestion(me, mine.id, "私の未決事項");
    startIssue(llm, review.id);
    completeIssue(llm, review.id, { summary: "やった" });
    const r = await call(app, "GET", "/api/inbox");
    expect(r.status).toBe(200);
    expect(r.json.questions.map((q: { issueId: string; question: string }) => [q.issueId, q.question])).toEqual([
      ["API-1", "どちらの方式にするか"],
    ]);
    expect(r.json.reviews.map((i: { id: string }) => i.id)).toEqual(["API-3"]);
  });

  test("Triage は Snooze の期限が来ていない Issue を除く", async () => {
    const { app, me, llm, ws } = setup();
    createIssue(llm, { workspaceId: ws.id, title: "a" });
    const later = createIssue(llm, { workspaceId: ws.id, title: "b" });
    snoozeTriage(me, later.id, "2999-01-01");
    const r = await call(app, "GET", "/api/triage");
    expect(r.status).toBe(200);
    expect(r.json.map((i: { id: string }) => i.id)).toEqual(["API-1"]);
  });
});

describe("GET /api/projects", () => {
  test("一覧は既定で完了と中止を除き、includeClosed=true で含める", async () => {
    const { app, db, me } = setup();
    createProject(me, { name: "認証" });
    createProject(me, { name: "移行" });
    db.query("UPDATE projects SET status = 'completed' WHERE name = '移行'").run();
    const active = await call(app, "GET", "/api/projects");
    expect(active.json.map((p: { name: string }) => p.name)).toEqual(["認証"]);
    const all = await call(app, "GET", "/api/projects?includeClosed=true");
    expect(all.json.map((p: { name: string }) => p.name).sort()).toEqual(["移行", "認証"].sort());
    expect((await call(app, "GET", "/api/projects?includeClosed=yes")).status).toBe(400);
  });

  test("詳細は名前か ID で引き、Issue を含める。ない Project は 404", async () => {
    const { app, me, ws } = setup();
    const p = createProject(me, { name: "認証 基盤" });
    createIssue(me, { workspaceId: ws.id, title: "t", projectRef: "認証 基盤" });
    const byName = await call(app, "GET", `/api/projects/${encodeURIComponent("認証 基盤")}`);
    expect(byName.status).toBe(200);
    expect(byName.json).toMatchObject({ id: p.id, total: 1, issues: [{ id: "API-1" }] });
    expect((await call(app, "GET", `/api/projects/${p.id}`)).json.name).toBe("認証 基盤");
    expect((await call(app, "GET", "/api/projects/none")).status).toBe(404);
  });
});

describe("GET /api/documents/:id", () => {
  test("登録済みの Document の本文を返し、ファイルが消えたら content を null にする", async () => {
    const { app, me, ws } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const path = join(tempDir(), "spec.md");
    writeFileSync(path, "# 設計\n\n本文\n");
    const doc = attachDocument(me, { issueRef: i.id }, { path });
    const r = await call(app, "GET", `/api/documents/${doc.id}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: doc.id, title: "設計", content: "# 設計\n\n本文\n" });
    rmSync(path);
    const gone = await call(app, "GET", `/api/documents/${doc.id}`);
    expect(gone.status).toBe(200);
    expect(gone.json).toMatchObject({ title: "設計", content: null });
  });

  test("数字でない id は 400、登録のない id は 404", async () => {
    const { app } = setup();
    expect((await call(app, "GET", "/api/documents/abc")).json.error.code).toBe("INVALID_ARGS");
    expect((await call(app, "GET", "/api/documents/1.5")).status).toBe(400);
    expect((await call(app, "GET", "/api/documents/999")).status).toBe(404);
  });
});
