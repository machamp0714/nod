import { describe, expect, test } from "bun:test";
import { createIssue, queryIssues } from "@nod/core";
import { call, setup } from "./helpers";

describe("View の API", () => {
  test("作成、一覧、取得、更新、削除ができる", async () => {
    const { app } = setup();
    const created = await call(app, "POST", "/api/views", {
      name: "仕事",
      color: "#3b82f6",
      filter: { workspace: ["api"], status: ["todo"] },
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: "仕事", color: "#3b82f6", filter: { workspace: ["API"], status: ["todo"] } });
    const id = created.json.id as number;
    await call(app, "POST", "/api/views", { name: "私用" });
    expect((await call(app, "GET", "/api/views")).json.map((v: { name: string }) => v.name)).toEqual(["仕事", "私用"]);
    expect((await call(app, "GET", `/api/views/${id}`)).json.name).toBe("仕事");
    const updated = await call(app, "PUT", `/api/views/${id}`, { name: "仕事（API）", position: 5 });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ name: "仕事（API）", position: 5, filter: { workspace: ["API"] } });
    const deleted = await call(app, "DELETE", `/api/views/${id}`);
    expect(deleted.json.name).toBe("仕事（API）");
    expect((await call(app, "GET", `/api/views/${id}`)).status).toBe(404);
  });

  test("View の filter をクエリパラメータにすると、GET /api/issues が同じ結果を返す", async () => {
    const { app, db, me, ws } = setup();
    createIssue(me, { workspaceId: ws.id, title: "a", labels: ["bug"] });
    createIssue(me, { workspaceId: ws.id, title: "b" });
    const view = (await call(app, "POST", "/api/views", { name: "bug", filter: { label: ["bug"], status: ["todo"] } })).json;
    const r = await call(app, "GET", "/api/issues?label=bug&status=todo");
    expect(r.json).toEqual(JSON.parse(JSON.stringify(queryIssues(db, view.filter))));
    expect(r.json.issues.map((i: { id: string }) => i.id)).toEqual(["API-1"]);
  });

  test("名前の重複は 409、不正な filter や本文は 400、数字でない id は 400", async () => {
    const { app } = setup();
    const a = (await call(app, "POST", "/api/views", { name: "a" })).json;
    expect((await call(app, "POST", "/api/views", { name: "a" })).json.error.code).toBe("VIEW_EXISTS");
    const bad: unknown[] = [
      {},
      { name: "b", filter: { sort: "title" } },
      { name: "b", filter: { status: ["wip"] } },
      { name: "b", position: -1 },
      { name: "b", position: "1" },
      { name: "b", color: 1 },
      { name: "b", id: 3 },
    ];
    for (const body of bad) {
      const r = await call(app, "POST", "/api/views", body);
      expect([body, r.status, r.json.error.code]).toEqual([body, 400, "INVALID_ARGS"]);
    }
    expect((await call(app, "PUT", `/api/views/${a.id}`, { filter: "status=todo" })).status).toBe(400);
    expect((await call(app, "GET", "/api/views/abc")).status).toBe(400);
    expect((await call(app, "PUT", "/api/views/999", { name: "c" })).status).toBe(404);
    expect((await call(app, "DELETE", "/api/views/999")).status).toBe(404);
  });
});
