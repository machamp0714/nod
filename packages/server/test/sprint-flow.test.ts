import { expect, test } from "bun:test";
import * as core from "@nod/core";
import { createApp } from "../src/app";
import { call, setup } from "./helpers";
import { acceptPreparedSprint, prepareSprint, sprintTestClock } from "../../core/test/fixtures/sprint-start";

test("HTTPのSprintフローと着手条件読取は採用中の版へ固定し、actor入力や実行許可を増やさない", async () => {
  const { db, ws, me } = setup();
  const issue = core.createIssue(me, { workspaceId: ws.id, title: "採択" });
  const proposal = prepareSprint(me, ws.key, [issue.id]);
  const app = createApp({ db, sprintClock: sprintTestClock });
  const before = await call(app, "GET", `/api/sprints/${proposal.sprint.id}/flow`);
  expect(before).toMatchObject({ status: 200, json: { mode: "planned", selectedCount: 1, planId: proposal.plan.id } });
  const ready = acceptPreparedSprint(me, proposal);
  const availability = await call(app, "GET", `/api/sprints/${ready.sprint.id}/planning-status`);
  expect(availability).toMatchObject({ status: 200, json: { canStart: true, reason: null, observedAt: sprintTestClock.now.toISOString() } });
  const expiredApp = createApp({ db, sprintClock: { now: new Date("2026-03-09T04:00:00.000Z") } });
  expect(await call(expiredApp, "GET", `/api/sprints/${ready.sprint.id}/planning-status`)).toMatchObject({ status: 200, json: { canStart: false, reason: { code: "SPRINT_EXPIRED" } } });
  const active = core.activateSprint(me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  const result = await call(app, "GET", `/api/sprints/${active.id}/items/${proposal.items[0]!.id}/eligibility`);
  expect(result).toMatchObject({ status: 200, json: { eligible: true, planId: proposal.plan.id, planHash: proposal.plan.contentHash } });
  const after = await call(app, "GET", `/api/sprints/${active.id}/flow?planId=別の計画`);
  expect(after).toMatchObject({ status: 200, json: { mode: "adopted", planId: proposal.plan.id, sprintVersion: active.version } });
  expect((await call(app, "POST", `/api/sprints/${active.id}/items/${proposal.items[0]!.id}/eligibility`, { actor: "me" })).status).toBe(404);
  expect((await call(app, "POST", `/api/issues/${issue.id}/start`, {})).status).not.toBe(200);
  expect(core.getSprint(db, active.id).version).toBe(active.version);
  db.close();
});
