import { expect, test } from "bun:test";
import * as core from "@nod/core";
import { acceptPreparedSprint, prepareSprint, sprintTestClock } from "../../core/test/fixtures/sprint-start";
import { call, setup } from "./helpers";

test("HTTPの一般更新と一括更新は採択Issueもin_progressにでき、自己申告の試行contextは受け付けない", async () => {
  const { db, ws, me, app } = setup();
  const adopted = core.createIssue(me, { workspaceId: ws.id, title: "採択" });
  const ordinary = core.createIssue(me, { workspaceId: ws.id, title: "通常" });
  const ready = acceptPreparedSprint(me, prepareSprint(me, ws.key, [adopted.id]));
  expect(await call(app, "POST", `/api/issues/${adopted.id}/update`, { status: "in_progress", assignee: "me" })).toMatchObject({ status: 200, json: { status: "in_progress", assignee: "me" } });
  expect(await call(app, "POST", `/api/issues/${adopted.id}/update`, { status: "todo" })).toMatchObject({ status: 200, json: { status: "todo" } });
  core.activateSprint(me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  expect(await call(app, "POST", "/api/issues/bulk-update", { ids: [ordinary.id, adopted.id], status: "in_progress", priority: 1 })).toMatchObject({ status: 200 });
  expect((await call(app, "GET", `/api/issues/${ordinary.id}`)).json).toMatchObject({ status: "in_progress", priority: 1 });
  expect((await call(app, "GET", `/api/issues/${adopted.id}`)).json).toMatchObject({ status: "in_progress", priority: 1 });
  expect(await call(app, "POST", `/api/issues/${adopted.id}/update`, { priority: 2 })).toMatchObject({ status: 200, json: { status: "in_progress", priority: 2 } });
  // 人向けHTTPに、自己申告の試行contextを受け入れる入口を増やさない。
  expect((await call(app, "POST", `/api/issues/${adopted.id}/update`, { status: "in_progress", attemptId: "架空" })).status).toBe(400);
  db.close();
});
