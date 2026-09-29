import { describe, expect, test } from "bun:test";
import { getWorkspaceRules, setWorkspaceRules } from "@nod/core";
import { call, setup } from "./helpers";

describe("作業規約API", () => {
  test("未登録なら GET は null を返す", async () => {
    const { app, ws } = setup();
    const res = await call(app, "GET", `/api/workspaces/${ws.key}/rules`);
    expect(res.status).toBe(200);
    expect(res.json).toBeNull();
  });

  test("PUT で登録・更新し、書き手は me になる。空白だけなら削除", async () => {
    const { app, db, ws } = setup();
    const put = await call(app, "PUT", `/api/workspaces/${ws.key}/rules`, { body: "- 日本語で書く\n" });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ workspaceKey: ws.key, body: "- 日本語で書く", updatedBy: "me" });
    expect((await call(app, "GET", `/api/workspaces/${ws.key.toLowerCase()}/rules`)).json.body).toBe("- 日本語で書く");
    const cleared = await call(app, "PUT", `/api/workspaces/${ws.key}/rules`, { body: " " });
    expect(cleared.json).toBeNull();
    expect(getWorkspaceRules(db, ws.key)).toBeNull();
  });

  test("DELETE で削除する", async () => {
    const { app, db, ws, me } = setup();
    setWorkspaceRules(me, ws.key, "a");
    const res = await call(app, "DELETE", `/api/workspaces/${ws.key}/rules`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ workspaceKey: ws.key, cleared: true });
    expect(getWorkspaceRules(db, ws.key)).toBeNull();
  });

  test("不正な本文・上限超過・未登録の Workspace を拒み、DB を保つ", async () => {
    const { app, db, ws, me } = setup();
    setWorkspaceRules(me, ws.key, "keep");
    for (const body of [undefined, {}, { body: 1 }, { body: null }, { body: "a", actor: "codex" }, "{", { body: "a".repeat(10001) }]) {
      const res = await call(app, "PUT", `/api/workspaces/${ws.key}/rules`, body);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("INVALID_ARGS");
    }
    expect(getWorkspaceRules(db, ws.key)?.body).toBe("keep");
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const res = await call(app, method, "/api/workspaces/ZZZ/rules", method === "PUT" ? { body: "a" } : undefined);
      expect(res.status).toBe(404);
    }
  });

  test("外部 Origin からの変更を拒む", async () => {
    const { app, db, ws } = setup();
    const res = await app.request(`/api/workspaces/${ws.key}/rules`, {
      method: "PUT",
      headers: { Origin: "https://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ body: "a" }),
    });
    expect(res.status).toBe(403);
    expect(getWorkspaceRules(db, ws.key)).toBeNull();
  });
});
