import { describe, expect, test } from "bun:test";
import { createIssue, getIssue } from "@nod/core";
import { call, setup } from "./helpers";

describe("POST /api/issues/bulk-update", () => {
  test("複数 Issue をまとめて更新し、書き手は me", async () => {
    const { app, db, me, ws } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    const r = await call(app, "POST", "/api/issues/bulk-update", {
      ids: [a.id, b.id], status: "in_progress", priority: 2, assignee: null, estimate: 5, dueDate: "2026-10-01", addLabels: ["x"],
    });
    expect(r.status).toBe(200);
    expect(r.json.map((i: { id: string }) => i.id)).toEqual([a.id, b.id]);
    expect(getIssue(db, b.id)).toMatchObject({ status: "in_progress", priority: 2, estimate: 5, dueDate: "2026-10-01", labels: ["x"] });
    const actors = db.query("SELECT DISTINCT actor FROM events WHERE type = 'status_changed'").all() as { actor: string }[];
    expect(actors).toEqual([{ actor: "me" }]);
  });

  test("一部が失敗したら 409 BULK_UPDATE_FAILED で失敗一覧を返し、何も書かない", async () => {
    const { app, db, me, llm, ws } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const t = createIssue(llm, { workspaceId: ws.id, title: "t" });
    const r = await call(app, "POST", "/api/issues/bulk-update", { ids: [a.id, t.id], status: "todo", priority: 1 });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({
      code: "BULK_UPDATE_FAILED",
      details: { failures: [{ id: t.id, code: "TRIAGE_DECISION_REQUIRED" }] },
    });
    expect(getIssue(db, a.id).priority).toBe(0);
  });

  test("ids の形・上限・未知のキー・不正な状態は 400", async () => {
    const { app, me, ws } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    for (const body of [
      { priority: 1 },
      { ids: "API-1", priority: 1 },
      { ids: [a.id], title: "x" },
      { ids: [a.id], status: "nope" },
      { ids: Array.from({ length: 101 }, (_, n) => `API-${n + 1}`), priority: 1 },
    ]) {
      const r = await call(app, "POST", "/api/issues/bulk-update", body);
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("INVALID_ARGS");
    }
  });

  test("単体の操作 /api/issues/:id/:op は従来どおり動く", async () => {
    const { app, me, ws } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const r = await call(app, "POST", `/api/issues/${a.id}/update`, { priority: 3 });
    expect(r.status).toBe(200);
    expect(r.json.priority).toBe(3);
  });
});
