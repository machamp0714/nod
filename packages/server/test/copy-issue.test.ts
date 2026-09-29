import { expect, test } from "bun:test";
import { createIssue, getIssue } from "@nod/core";
import { call, setup } from "./helpers";

test("POST /api/issues/:id/copy は 201 で新しい Issue を返し、元の Issue を変えない", async () => {
  const { app, db, me, ws } = setup();
  const src = createIssue(me, { workspaceId: ws.id, title: "元", description: "説明", priority: 3, labels: ["x"] });
  const before = getIssue(db, src.id);
  const r = await call(app, "POST", `/api/issues/${src.id}/copy`, {});
  expect(r.status).toBe(201);
  expect(r.json).toMatchObject({ id: "API-2", title: "元", description: "説明", priority: 3, labels: ["x"], status: "todo", createdBy: "me" });
  const renamed = await call(app, "POST", `/api/issues/${src.id}/copy`, { title: "別名" });
  expect(renamed.json.title).toBe("別名");
  expect(getIssue(db, src.id)).toEqual(before);
});

test("存在しない ID は 404、不正な入力は 400 で、何も作らない", async () => {
  const { app, db, me, ws } = setup();
  const src = createIssue(me, { workspaceId: ws.id, title: "元" });
  const before = db.serialize();
  expect((await call(app, "POST", "/api/issues/API-999/copy", {})).status).toBe(404);
  for (const body of [{ title: "" }, { title: 1 }, { extra: true }, "not json"]) {
    const r = await call(app, "POST", `/api/issues/${src.id}/copy`, body);
    expect(r.status).toBe(400);
  }
  expect(db.serialize()).toEqual(before);
});
