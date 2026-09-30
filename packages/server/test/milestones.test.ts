import { describe, expect, test } from "bun:test";
import { createIssue, createProject, getIssue, getProject } from "@nod/core";
import { call, setup } from "./helpers";

describe("Milestone API", () => {
  test("作成・編集・削除し、Project 詳細に進捗つきで返す", async () => {
    const { app, db, me } = setup();
    const p = createProject(me, { name: "検索" });
    const created = await call(app, "POST", `/api/projects/${encodeURIComponent(p.name)}/milestones`, {
      name: "β公開",
      targetDate: "2026-11-30",
      description: "社内向け",
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ projectId: p.id, name: "β公開", targetDate: "2026-11-30", createdBy: "me", total: 0, done: 0 });
    const updated = await call(app, "POST", `/api/milestones/${created.json.id}/update`, { name: "β", targetDate: null, description: null });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ name: "β", targetDate: null, description: null });
    expect((await call(app, "GET", `/api/projects/${p.id}`)).json.milestones).toEqual([updated.json]);
    const removed = await call(app, "DELETE", `/api/milestones/${created.json.id}`);
    expect(removed.json).toEqual({ id: created.json.id });
    expect(getProject(db, "検索").milestones).toEqual([]);
  });

  test("不正な入力・重複・存在しない Milestone を拒む", async () => {
    const { app, db, me } = setup();
    const p = createProject(me, { name: "検索" });
    await call(app, "POST", `/api/projects/${p.id}/milestones`, { name: "α" });
    for (const body of [{}, { name: "" }, { name: 1 }, { name: "12" }, { name: "β", targetDate: "明日" }, { name: "β", owner: "x" }]) {
      const res = await call(app, "POST", `/api/projects/${p.id}/milestones`, body);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("INVALID_ARGS");
    }
    const dup = await call(app, "POST", `/api/projects/${p.id}/milestones`, { name: "α" });
    expect([dup.status, dup.json.error.code]).toEqual([409, "MILESTONE_EXISTS"]);
    expect((await call(app, "POST", "/api/projects/999/milestones", { name: "x" })).status).toBe(404);
    expect((await call(app, "POST", "/api/milestones/999/update", { name: "x" })).status).toBe(404);
    expect((await call(app, "DELETE", "/api/milestones/999")).status).toBe(404);
    expect((await call(app, "DELETE", "/api/milestones/abc")).status).toBe(400);
    expect(getProject(db, "検索").milestones.map((m) => m.name)).toEqual(["α"]);
  });

  test("Issue に milestoneRef で付け外しし、Milestone で Issue 一覧を絞り込める", async () => {
    const { app, db, ws, me } = setup();
    const p = createProject(me, { name: "検索" });
    const other = createProject(me, { name: "認証" });
    const m = (await call(app, "POST", `/api/projects/${p.id}/milestones`, { name: "α" })).json;
    const foreign = (await call(app, "POST", `/api/projects/${other.id}/milestones`, { name: "別" })).json;
    const issue = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "検索" });
    createIssue(me, { workspaceId: ws.id, title: "b", projectRef: "検索" });
    const set = await call(app, "POST", `/api/issues/${issue.id}/update`, { milestoneRef: String(m.id) });
    expect(set.status).toBe(200);
    expect(set.json.milestone).toEqual({ id: m.id, name: "α" });
    const listed = await call(app, "GET", `/api/issues?milestone=${m.id}`);
    expect(listed.json.issues.map((i: { id: string }) => i.id)).toEqual([issue.id]);
    const bad = await call(app, "POST", `/api/issues/${issue.id}/update`, { milestoneRef: String(foreign.id) });
    expect([bad.status, bad.json.error.code]).toEqual([400, "INVALID_ARGS"]);
    expect((await call(app, "GET", "/api/issues?milestone=none&project=" + p.id)).json.issues.map((i: { title: string }) => i.title)).toEqual(["b"]);
    expect((await call(app, "GET", "/api/issues?milestone=x")).status).toBe(400);
    expect((await call(app, "POST", `/api/issues/${issue.id}/update`, { milestoneRef: null })).json.milestone).toBeNull();
    expect(getIssue(db, issue.id).milestone).toBeNull();
    // 空文字も CLI の --milestone "" と同じく外す
    await call(app, "POST", `/api/issues/${issue.id}/update`, { milestoneRef: String(m.id) });
    const cleared = await call(app, "POST", `/api/issues/${issue.id}/update`, { milestoneRef: "" });
    expect([cleared.status, cleared.json.milestone]).toEqual([200, null]);
    expect(getIssue(db, issue.id).milestone).toBeNull();
  });

  test("GET /api/milestones はすべての Project の Milestone を Project の名前順に返す", async () => {
    const { app, me } = setup();
    createProject(me, { name: "b 認証" });
    createProject(me, { name: "a 検索" });
    await call(app, "POST", `/api/projects/${encodeURIComponent("b 認証")}/milestones`, { name: "認証α" });
    await call(app, "POST", `/api/projects/${encodeURIComponent("a 検索")}/milestones`, { name: "後", targetDate: "2026-12-01" });
    await call(app, "POST", `/api/projects/${encodeURIComponent("a 検索")}/milestones`, { name: "先", targetDate: "2026-10-01" });
    const res = await call(app, "GET", "/api/milestones");
    expect(res.json.map((m: { name: string }) => m.name)).toEqual(["先", "後", "認証α"]);
  });

  test("外部Originからの Milestone 操作を拒む", async () => {
    const { app, db, me } = setup();
    const p = createProject(me, { name: "保護" });
    const res = await app.request(`/api/projects/${p.id}/milestones`, {
      method: "POST", headers: { Origin: "https://example.com", "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(403);
    expect(getProject(db, p.name).milestones).toEqual([]);
  });
});
