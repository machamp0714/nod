import { expect, test } from "bun:test";
import * as core from "@nod/core";
import { setup, call } from "./helpers";
import { createApp } from "../src/app";
import { prepareSprint, acceptPreparedSprint, sprintTestClock } from "../../core/test/fixtures/sprint-start";

test("HTTPの保存状態読取はcoreと同じ時計・監督・予約・通知結果を返し、agent書込を公開しない", async () => {
  const { db, me, ws } = setup();
  const issue = core.createIssue(me, { workspaceId: ws.id, title: "監督を確認する" });
  const planned = prepareSprint(me, ws.key, [issue.id]), ready = acceptPreparedSprint(me, planned);
  const sprint = core.activateSprint(me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  const agent = { db, actor: "codex" };
  const session = await core.beginSprintSession(agent, sprint.id, { expectedVersion: sprint.version, requestKey: "監督", runId: "元Run" }, {
    authority: async () => ({ runId: "元Run", caller: "現在の監督", coordinator: "現在の監督", consumerGeneration: 1, runtimeId: "home", source: "模擬Orca", observedAt: sprintTestClock.now.toISOString() }),
  }, sprintTestClock);
  core.prepareSprintExecution(agent, sprint.id, { sessionId: session.id, generation: 1, requestKey: "担当", itemId: planned.items[0]!.id,
    actor: "codex", spec: "確認する", placement: { agent: "codex", worktree: "path:/専用" } }, sprintTestClock);
  const clock = { now: new Date("2026-03-08T12:03:00.000Z") }, app = createApp({ db, sprintClock: clock });
  const response = await call(app, "GET", `/api/sprints/${sprint.id}/execution`);
  expect(response.status).toBe(200);
  expect(response.json).toEqual(core.getSprintNotificationState(db, sprint.id, clock));
  expect(response.json.execution).toMatchObject({ occupied: 1, reserved: 1, maxParallel: 1, stale: true, observedAt: "2026-03-08T12:03:00.000Z" });
  expect(response.json.execution.nextActions[0].command).toContain("NOD_ACTOR='codex'");
  for (const route of ["execution", "session/begin", "execution/receive"]) {
    expect((await call(app, "POST", `/api/sprints/${sprint.id}/${route}`, { actor: "codex", authorized: true })).status).toBe(404);
  }
  expect((await call(app, "GET", `/api/sprints/${sprint.id}/execution?actor=codex`)).json).toEqual(response.json);
  db.close();
});
