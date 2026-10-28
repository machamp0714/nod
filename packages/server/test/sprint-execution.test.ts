import { expect, test } from "bun:test";
import * as core from "@nod/core";
import { setup, call } from "./helpers";
import { createApp } from "../src/app";
import { prepareSprint, acceptPreparedSprint, sprintTestClock } from "../../core/test/fixtures/sprint-start";

test("HTTPの計画合意は未解決の所有と並行上限を409で拒否し、coreと同じ理由を保つ", async () => {
  const { db, me, ws } = setup();
  try {
    const issues = ["先の担当", "次の担当"].map(title => core.createIssue(me, { workspaceId: ws.id, title }));
    const prepared = prepareSprint(me, ws.key, issues.map(i => i.id));
    const proposed = core.proposeSprintPlan(me, prepared.sprint.id, { ...prepared.input,
      expectedVersion: prepared.sprint.version, requestKey: "二枠の計画", constraints: { ...prepared.input.constraints, maxParallel: 2 } });
    const ready = acceptPreparedSprint(me, { ...prepared, ...proposed });
    const sprint = core.activateSprint(me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
    const agent = { db, actor: "codex" };
    const session = await core.beginSprintSession(agent, sprint.id, { expectedVersion: sprint.version, requestKey: "監督", runId: "元Run" }, {
      authority: async () => ({ runId: "元Run", caller: "監督", coordinator: "監督", consumerGeneration: 1, runtimeId: "home", source: "模擬Orca", observedAt: sprintTestClock.now.toISOString() }),
    }, sprintTestClock);
    for (const item of prepared.items) core.prepareSprintExecution(agent, sprint.id, {
      sessionId: session.id, generation: 1, requestKey: item.id, itemId: item.id, actor: "codex", spec: "確認する",
      placement: { agent: "codex", worktree: "path:/専用" },
    }, sprintTestClock);
    const app = createApp({ db, sprintClock: sprintTestClock });
    for (const change of [
      { key: "所有の除外", items: prepared.input.items.slice(1), maxParallel: 2,
        code: "EXECUTION_OWNED", message: "未解決の試行を採択から除外できません。元Task・Dispatchと引継ぎを照合してください" },
      { key: "枠の縮小", items: prepared.input.items, maxParallel: 1,
        code: "PARALLEL_LIMIT", message: "未解決の予約を下回る並行上限へ変更できません" },
    ]) {
      const current = core.getSprint(db, sprint.id);
      const proposal = await call(app, "POST", `/api/sprints/${sprint.id}/plans`, { ...prepared.input,
        expectedVersion: current.version, requestKey: change.key, items: change.items,
        constraints: { ...prepared.input.constraints, maxParallel: change.maxParallel } });
      expect(proposal.status).toBe(201);
      const input = { expectedVersion: proposal.json.sprint.version, requestKey: `合意:${change.key}`, contentHash: proposal.json.plan.contentHash };
      expect(() => core.acceptSprintPlan(me, sprint.id, proposal.json.plan.id, input)).toThrow(change.message);
      const response = await call(app, "POST", `/api/sprints/${sprint.id}/plans/${proposal.json.plan.id}/accept`, input);
      expect(response).toEqual({ status: 409, json: { error: { code: change.code, message: change.message } } });
      const saved = await call(app, "GET", `/api/sprints/${sprint.id}/execution`);
      expect(saved.json.execution).toMatchObject({ occupied: 2, reserved: 2, maxParallel: 2 });
      expect(core.getSprint(db, sprint.id).adoptedPlanId).toBe(ready.plan.id);
    }
  } finally { db.close(); }
});

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
