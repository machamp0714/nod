import { describe, expect, test } from "bun:test";
import { createIssue } from "@nod/core";
import { call, setup } from "./helpers";

describe("update の見積もりと期限", () => {
  test("estimate と dueDate を設定し、null で解除でき、GET に出る", async () => {
    const { app, me, ws } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const set = await call(app, "POST", `/api/issues/${i.id}/update`, { estimate: 8, dueDate: "2026-10-01" });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ estimate: 8, dueDate: "2026-10-01" });
    const detail = await call(app, "GET", `/api/issues/${i.id}`);
    expect(detail.json).toMatchObject({ estimate: 8, dueDate: "2026-10-01" });
    const list = await call(app, "GET", "/api/issues");
    expect(list.json.issues[0]).toMatchObject({ estimate: 8, dueDate: "2026-10-01" });
    const cleared = await call(app, "POST", `/api/issues/${i.id}/update`, { estimate: null, dueDate: null });
    expect(cleared.json).toMatchObject({ estimate: null, dueDate: null });
  });

  test("不正な値は 400 INVALID_ARGS で、何も変えない", async () => {
    const { app, me, ws } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t", estimate: 2 });
    for (const body of [{ estimate: 0 }, { estimate: 101 }, { estimate: 1.5 }, { estimate: "3" }, { dueDate: "2026-02-30" }, { dueDate: "0002-10-15" }, { dueDate: 20261001 }, { dueDate: "2026-10-01T00:00:00Z" }, { title: "変更", estimate: 0 }]) {
      const r = await call(app, "POST", `/api/issues/${i.id}/update`, body);
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("INVALID_ARGS");
    }
    const after = await call(app, "GET", `/api/issues/${i.id}`);
    expect(after.json).toMatchObject({ title: "t", estimate: 2, dueDate: null });
  });
});
