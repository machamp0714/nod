import { describe, expect, test } from "bun:test";
import { createIssue, createProject, getInitiative, updateIssue } from "@nod/core";
import { call, setup } from "./helpers";

describe("Initiative API", () => {
  test("作成・更新・Project の紐付けと解除、合算進捗を返す", async () => {
    const { app, db, ws, me } = setup();
    const created = await call(app, "POST", "/api/initiatives", { name: "検索の刷新", description: "説明", targetDate: "2026-12-31" });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: "検索の刷新", targetDate: "2026-12-31", status: "planned", createdBy: "me" });
    const id = created.json.id;
    createProject(me, { name: "A" });
    const b = createProject(me, { name: "B" });
    const done = createIssue(me, { workspaceId: ws.id, title: "完了", projectRef: "A" });
    updateIssue(me, done.id, { status: "done" });
    createIssue(me, { workspaceId: ws.id, title: "未完", projectRef: "B" });

    expect((await call(app, "POST", `/api/initiatives/${id}/projects`, { project: "A" })).status).toBe(200);
    const linked = await call(app, "POST", `/api/initiatives/${encodeURIComponent("検索の刷新")}/projects`, { project: String(b.id) });
    expect(linked.json).toMatchObject({ projectCount: 2, total: 2, done: 1 });
    expect((await call(app, "GET", `/api/initiatives/${id}`)).json.projects.map((p: { name: string }) => p.name)).toEqual(["A", "B"]);
    expect((await call(app, "GET", "/api/projects/A")).json.initiatives).toEqual([{ id, name: "検索の刷新" }]);

    const updated = await call(app, "POST", `/api/initiatives/${id}/update`, { status: "completed", targetDate: null });
    expect(updated.json).toMatchObject({ status: "completed", targetDate: null });
    expect((await call(app, "GET", "/api/initiatives")).json).toEqual([]);
    expect((await call(app, "GET", "/api/initiatives?includeClosed=true")).json).toHaveLength(1);

    const removed = await call(app, "DELETE", `/api/initiatives/${id}/projects/A`);
    expect(removed.json).toMatchObject({ projectCount: 1, total: 1, done: 0 });
    expect(getInitiative(db, String(id)).projects.map((p) => p.name)).toEqual(["B"]);
  });

  test("不正な本文・重複・不存在を拒む", async () => {
    const { app, db, me } = setup();
    await call(app, "POST", "/api/initiatives", { name: "保持" });
    for (const [method, path, body, status, code] of [
      ["POST", "/api/initiatives", {}, 400, "INVALID_ARGS"],
      ["POST", "/api/initiatives", { name: "x", actor: "codex" }, 400, "INVALID_ARGS"],
      ["POST", "/api/initiatives", { name: "新", targetDate: "2026-13-01" }, 400, "INVALID_ARGS"],
      ["POST", "/api/initiatives", { name: "保持" }, 409, "INITIATIVE_EXISTS"],
      ["POST", "/api/initiatives/保持/update", { status: "done" }, 400, "INVALID_ARGS"],
      ["POST", "/api/initiatives/保持/update", {}, 400, "INVALID_ARGS"],
      ["POST", "/api/initiatives/999/update", { status: "started" }, 404, "NOT_FOUND"],
      ["POST", "/api/initiatives/保持/projects", { project: "ない" }, 404, "NOT_FOUND"],
      ["DELETE", "/api/initiatives/保持/projects/ない", undefined, 404, "NOT_FOUND"],
    ] as const) {
      const res = await call(app, method, encodeURI(path), body);
      expect([res.status, res.json.error.code]).toEqual([status, code]);
    }
    createProject(me, { name: "未紐付け" });
    expect((await call(app, "DELETE", `/api/initiatives/${encodeURIComponent("保持")}/projects/${encodeURIComponent("未紐付け")}`)).status).toBe(404);
    expect(getInitiative(db, "保持")).toMatchObject({ status: "planned", projectCount: 0 });
  });
});
