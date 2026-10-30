import { expect, test } from "bun:test";
import * as core from "@nod/core";
import { acceptPreparedSprint, prepareSprint, sprintTestClock } from "../../core/test/fixtures/sprint-start";
import { call, setup } from "./helpers";

test("HTTPの一般更新は管理中Issueの着手を409で拒否し、一括更新も全件を変更しない", async () => {
  const { db, ws, me, app } = setup();
  const adopted = core.createIssue(me, { workspaceId: ws.id, title: "採択" });
  const ordinary = core.createIssue(me, { workspaceId: ws.id, title: "通常" });
  const ready = acceptPreparedSprint(me, prepareSprint(me, ws.key, [adopted.id]));
  const before = core.getIssue(db, adopted.id);
  expect(await call(app, "POST", `/api/issues/${adopted.id}/update`, { status: "in_progress", assignee: "me", title: "迂回" })).toMatchObject({ status: 409, json: { error: { code: "SPRINT_CONTEXT_REQUIRED" } } });
  expect((await call(app, "GET", `/api/issues/${adopted.id}`)).json).toEqual(before);
  core.activateSprint(me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  expect(await call(app, "POST", "/api/issues/bulk-update", { ids: [ordinary.id, adopted.id], status: "in_progress", priority: 1 })).toMatchObject({ status: 409, json: { error: { code: "BULK_UPDATE_FAILED", details: { failures: [{ id: adopted.id, code: "SPRINT_CONTEXT_REQUIRED" }] } } } });
  expect((await call(app, "GET", `/api/issues/${ordinary.id}`)).json).toMatchObject({ status: "todo", priority: 0 });
  expect(await call(app, "POST", `/api/issues/${ordinary.id}/update`, { status: "in_progress" })).toMatchObject({ status: 200, json: { status: "in_progress" } });
  expect(await call(app, "POST", `/api/issues/${adopted.id}/update`, { priority: 2 })).toMatchObject({ status: 200, json: { status: "todo", priority: 2 } });
  // 人向けHTTPに、自己申告の試行contextを受け入れる入口を増やさない。
  expect((await call(app, "POST", `/api/issues/${adopted.id}/update`, { status: "in_progress", attemptId: "架空" })).status).toBe(400);
  db.close();
});
