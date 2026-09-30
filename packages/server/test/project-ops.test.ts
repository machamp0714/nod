import { describe, expect, test } from "bun:test";
import { createIssue, createProject, getProject, updateIssue } from "@nod/core";
import { call, setup } from "./helpers";

describe("Project 更新API", () => {
  test("名前とIDで四状態を変更し、同値更新と一覧の可視性を保つ", async () => {
    const { app, me } = setup();
    const p = createProject(me, { name: "認証 基盤 v1.0" });
    for (const status of ["started", "completed", "canceled", "planned"]) {
      const ref = status === "started" ? encodeURIComponent(p.name) : p.id;
      const res = await call(app, "POST", `/api/projects/${ref}/update`, { status });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ id: p.id, status });
      expect((await call(app, "POST", `/api/projects/${p.id}/update`, { status })).json.updatedAt).toBe(res.json.updatedAt);
      const active = await call(app, "GET", "/api/projects");
      expect(active.json).toHaveLength(status === "planned" || status === "started" ? 1 : 0);
      expect((await call(app, "GET", "/api/projects?includeClosed=true")).json).toHaveLength(1);
    }
  });

  test("不正な本文と存在しないProjectを拒みDBを保持する", async () => {
    const { app, db, me } = setup();
    const p = createProject(me, { name: "保持" });
    for (const body of [undefined, {}, null, [], "{", { status: null }, { status: 3 }, { status: "done" }, { status: "completed", actor: "codex" }]) {
      const res = await call(app, "POST", `/api/projects/${p.id}/update`, body);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("INVALID_ARGS");
      expect(getProject(db, p.name)).toMatchObject(p);
    }
    const missing = await call(app, "POST", "/api/projects/999/update", { status: "completed" });
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe("NOT_FOUND");
  });

  test("外部Originの更新を拒みDBを保持する", async () => {
    const { app, db, me } = setup();
    const p = createProject(me, { name: "保護" });
    const res = await app.request(`/api/projects/${p.id}/update`, {
      method: "POST", headers: { Origin: "https://example.com", "Content-Type": "application/json" }, body: JSON.stringify({ status: "completed" }),
    });
    expect(res.status).toBe(403);
    expect(getProject(db, p.name)).toMatchObject(p);
  });

  test("GETの一覧と詳細に同じレビュー待ち件数を返す", async () => {
    const { app, ws, me } = setup();
    const p = createProject(me, { name: "レビュー" });
    const issue = createIssue(me, { workspaceId: ws.id, title: "確認", projectRef: p.name });
    updateIssue(me, issue.id, { status: "in_review" });
    expect((await call(app, "GET", "/api/projects")).json[0].agents.awaitingReview).toBe(1);
    expect((await call(app, "GET", `/api/projects/${p.id}`)).json.agents.awaitingReview).toBe(1);
  });
});

describe("Project 進捗報告API", () => {
  test("名前とIDで書き、書き手 me と日時つきで詳細に新しい順で返す", async () => {
    const { app, db, me } = setup();
    const p = createProject(me, { name: "認証 基盤 v1.0" });
    const other = createProject(me, { name: "別" });
    const before = getProject(db, p.name);
    const first = await call(app, "POST", `/api/projects/${encodeURIComponent(p.name)}/reports`, { body: "<b>太字</b>\n二行目" });
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ projectId: p.id, author: "me", body: "<b>太字</b>\n二行目" });
    const second = await call(app, "POST", `/api/projects/${p.id}/reports`, { body: "次" });
    await call(app, "POST", `/api/projects/${other.id}/reports`, { body: "別の報告" });
    const detail = await call(app, "GET", `/api/projects/${p.id}`);
    expect(detail.json.updates).toEqual([second.json, first.json]);
    expect(detail.json).toMatchObject({ status: before.status, updatedAt: before.updatedAt });
    expect((await call(app, "GET", `/api/projects/${other.id}`)).json.updates.map((u: { body: string }) => u.body)).toEqual(["別の報告"]);
  });

  test("不正な本文・上限超過・存在しないProjectを拒み、何も保存しない", async () => {
    const { app, db, me } = setup();
    const p = createProject(me, { name: "保持" });
    for (const body of [undefined, {}, null, [], "{", { body: null }, { body: 3 }, { body: "" }, { body: " \n " }, { body: "あ".repeat(10001) }, { body: "x", author: "codex" }]) {
      const res = await call(app, "POST", `/api/projects/${p.id}/reports`, body);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("INVALID_ARGS");
    }
    const missing = await call(app, "POST", "/api/projects/999/reports", { body: "本文" });
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe("NOT_FOUND");
    expect(getProject(db, p.name).updates).toEqual([]);
  });

  test("外部Originの投稿を拒む", async () => {
    const { app, db, me } = setup();
    const p = createProject(me, { name: "保護" });
    const res = await app.request(`/api/projects/${p.id}/reports`, {
      method: "POST", headers: { Origin: "https://example.com", "Content-Type": "application/json" }, body: JSON.stringify({ body: "x" }),
    });
    expect(res.status).toBe(403);
    expect(getProject(db, p.name).updates).toEqual([]);
  });
});
