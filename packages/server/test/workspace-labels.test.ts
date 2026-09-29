import { describe, expect, test } from "bun:test";
import { addWorkspaceLabel, createIssue, getStatusNames, listWorkspaceLabels, setStatusNames } from "@nod/core";
import { call, setup } from "./helpers";

describe("ラベル定義API", () => {
  test("追加・一覧・変更・改名・削除ができ、改名は Issue のラベルにも反映する", async () => {
    const { app, db, ws, me } = setup();
    const issue = createIssue(me, { workspaceId: ws.id, title: "a", labels: ["bug"] });
    const added = await call(app, "POST", `/api/workspaces/${ws.key}/labels`, { name: "bug", color: "#db2777", description: "不具合" });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ workspaceKey: ws.key, name: "bug", color: "#DB2777", description: "不具合", issueCount: 1 });
    expect((await call(app, "GET", `/api/workspaces/${ws.key.toLowerCase()}/labels`)).json).toEqual([added.json]);
    expect((await call(app, "GET", "/api/labels")).json).toEqual([added.json]);

    const renamed = await call(app, "POST", `/api/workspaces/${ws.key}/labels/update`, { name: "bug", newName: "defect", color: "#2563EB" });
    expect(renamed.status).toBe(200);
    expect(renamed.json).toMatchObject({ name: "defect", color: "#2563EB", description: "不具合", issueCount: 1 });
    expect((await call(app, "GET", `/api/issues/${issue.id}`)).json.labels).toEqual(["defect"]);

    const removed = await call(app, "POST", `/api/workspaces/${ws.key}/labels/remove`, { name: "defect" });
    expect(removed.json).toEqual({ workspaceKey: ws.key, name: "defect", removed: true });
    expect(listWorkspaceLabels(db, ws.key)).toEqual([]);
    expect((await call(app, "GET", `/api/issues/${issue.id}`)).json.labels).toEqual(["defect"]);
  });

  test("不正な入力・重複・未定義・未登録の Workspace を拒み、DB を保つ", async () => {
    const { app, db, ws, me } = setup();
    addWorkspaceLabel(me, ws.key, { name: "bug", color: "#DB2777" });
    for (const body of [undefined, { name: "x" }, { name: 1, color: "#DB2777" }, { name: "a b", color: "#DB2777" }, { name: "x", color: "red" }, { name: "x", color: "#DB2777", actor: "codex" }]) {
      const res = await call(app, "POST", `/api/workspaces/${ws.key}/labels`, body);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("INVALID_ARGS");
    }
    const dup = await call(app, "POST", `/api/workspaces/${ws.key}/labels`, { name: "bug", color: "#2563EB" });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("LABEL_EXISTS");
    expect((await call(app, "POST", `/api/workspaces/${ws.key}/labels/update`, { name: "nope", color: "#2563EB" })).status).toBe(404);
    expect((await call(app, "POST", `/api/workspaces/${ws.key}/labels/remove`, { name: "nope" })).status).toBe(404);
    expect((await call(app, "GET", "/api/workspaces/ZZZ/labels")).status).toBe(404);
    expect(listWorkspaceLabels(db, ws.key).map((l) => [l.name, l.color])).toEqual([["bug", "#DB2777"]]);
  });

  test("外部 Origin からの変更を拒む", async () => {
    const { app, db, ws } = setup();
    const res = await app.request(`/api/workspaces/${ws.key}/labels`, {
      method: "POST",
      headers: { Origin: "https://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bug", color: "#DB2777" }),
    });
    expect(res.status).toBe(403);
    expect(listWorkspaceLabels(db, ws.key)).toEqual([]);
  });
});

describe("ステータス表示名API", () => {
  test("GET・PUT で表示名を読み書きし、全 Workspace 分も返す", async () => {
    const { app, db, ws } = setup();
    expect((await call(app, "GET", `/api/workspaces/${ws.key}/status-names`)).json).toEqual({ workspaceKey: ws.key, names: {} });
    const put = await call(app, "PUT", `/api/workspaces/${ws.key}/status-names`, { names: { todo: " 着手可 ", done: null, in_review: "" } });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({ workspaceKey: ws.key, names: { todo: "着手可" } });
    expect(getStatusNames(db, ws.key).names).toEqual({ todo: "着手可" });
    expect((await call(app, "GET", "/api/status-names")).json).toEqual({ [ws.key]: { todo: "着手可" } });
  });

  test("表示名を変えても Issue の status は内部値のまま", async () => {
    const { app, ws, me } = setup();
    const issue = createIssue(me, { workspaceId: ws.id, title: "a" });
    await call(app, "PUT", `/api/workspaces/${ws.key}/status-names`, { names: { todo: "着手可" } });
    expect((await call(app, "GET", `/api/issues/${issue.id}`)).json.status).toBe("todo");
  });

  test("不正な本文・未知のステータス・未登録の Workspace を拒み、DB を保つ", async () => {
    const { app, db, ws, me } = setup();
    setStatusNames(me, ws.key, { todo: "keep" });
    for (const body of [undefined, { names: [] }, { names: "x" }, { names: { todo: 1 } }, { names: { ready: "x" } }, { names: {}, actor: "x" }]) {
      const res = await call(app, "PUT", `/api/workspaces/${ws.key}/status-names`, body);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("INVALID_ARGS");
    }
    expect(getStatusNames(db, ws.key).names).toEqual({ todo: "keep" });
    expect((await call(app, "GET", "/api/workspaces/ZZZ/status-names")).status).toBe(404);
    expect((await call(app, "PUT", "/api/workspaces/ZZZ/status-names", { names: {} })).status).toBe(404);
  });
});
