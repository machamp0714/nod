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
