import { expect, test } from "bun:test";
import { createIssue } from "@nod/core";
import { call, setup } from "./helpers";

test("POST /api/issues/:id/archive・unarchive で切り替え、GET /api/issues は archived=true でだけ返す", async () => {
  const { app, me, ws } = setup();
  const keep = createIssue(me, { workspaceId: ws.id, title: "残す" });
  const gone = createIssue(me, { workspaceId: ws.id, title: "消す" });
  const r = await call(app, "POST", `/api/issues/${gone.id}/archive`, { reason: "不要" });
  expect(r.status).toBe(200);
  expect(r.json.archivedAt).not.toBeNull();
  expect((await call(app, "GET", "/api/issues")).json.issues.map((i: { id: string }) => i.id)).toEqual([keep.id]);
  expect((await call(app, "GET", "/api/issues?archived=true")).json.issues.map((i: { id: string }) => i.id)).toEqual([gone.id]);
  expect((await call(app, "GET", `/api/issues/${gone.id}`)).json.archivedAt).not.toBeNull();

  const edit = await call(app, "POST", `/api/issues/${gone.id}/comment`, { body: "x" });
  expect(edit.status).toBe(409);
  expect(edit.json.error.code).toBe("ISSUE_ARCHIVED");

  const u = await call(app, "POST", `/api/issues/${gone.id}/unarchive`, {});
  expect(u.status).toBe(200);
  expect(u.json.archivedAt).toBeNull();
  expect((await call(app, "GET", "/api/issues?archived=false")).json.issues).toHaveLength(2);
});

test("不正な入力は 400、存在しない ID は 404", async () => {
  const { app, me, ws } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "x" });
  expect((await call(app, "POST", `/api/issues/${issue.id}/archive`, { reason: 1 })).status).toBe(400);
  expect((await call(app, "POST", `/api/issues/${issue.id}/unarchive`, { reason: "x" })).status).toBe(400);
  expect((await call(app, "POST", "/api/issues/API-99/archive", {})).status).toBe(404);
  expect((await call(app, "GET", "/api/issues?archived=yes")).status).toBe(400);
});
