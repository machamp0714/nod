import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import * as core from "@nod/core";
import { createApp } from "../src/app";
import { type NodServer, startServer } from "../src/server";
import { call, setup, sseReader, tempDir } from "./helpers";

// 分岐の網羅は core の sprint-rollover.test.ts にある。ここではサーバーの契機とAPIの配線だけを確かめる。
const running: NodServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
});

// Asia/Tokyo の 2020-01-06〜2020-01-12 に人が合意・開始した Sprint。実時計では期限切れになる。
function activeSprint(db: Database, wsKey: string, wsId: number) {
  const me = { db, actor: core.HUMAN_ACTOR }, llm = { db, actor: "codex" };
  core.configureScrumWorkspace(me, wsKey, { expectedVersion: 0, requestKey: "設定", enabled: true, problem: "停滞", productGoal: "進める", priorityRationale: "判断を優先" });
  const created = core.createSprint(llm, { workspaceKey: wsKey, name: "過去のSprint", startDate: "2020-01-06", endDate: "2020-01-12", timezone: "Asia/Tokyo",
    expectedVersion: 0, requestKey: "作成" });
  const issue = core.createIssue(me, { workspaceId: wsId, title: "未完了" });
  core.addIssueToSprint(llm, created.id, { issueRef: issue.id });
  const proposed = core.proposeSprintPlan(llm, created.id, { expectedVersion: created.version, requestKey: "計画", goal: "前のゴール", verificationMethod: "確認する",
    items: [], definitionOfDone: [{ id: "前", text: "前の完成の定義" }], constraints: { executionScope: "WS", maxParallel: 1, notes: "なし" }, changeReason: "最初の提案" });
  const ready = core.acceptSprintPlan(me, created.id, proposed.plan.id, { expectedVersion: proposed.sprint.version, requestKey: "合意", contentHash: proposed.plan.contentHash });
  return core.activateSprint(me, created.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, { now: new Date(created.startsAt!) });
}

function expiredDb(): { dbPath: string; sprint: core.Sprint } {
  const dbPath = join(tempDir(), "nod.db");
  const db = core.openDb(dbPath);
  try {
    const ws = core.initWorkspace(db, { path: "/tmp/repos/api-server" }).workspace;
    return { dbPath, sprint: activeSprint(db, ws.key, ws.id) };
  } finally {
    db.close();
  }
}

test("startServer は起動時に期限切れのSprintを引き継ぐ", async () => {
  const { dbPath, sprint } = expiredDb();
  const server = startServer({ port: 0, dbPath, rolloverIntervalMs: 3_600_000 });
  running.push(server);
  const sprints = await (await fetch(`${server.url}/api/sprints`)).json() as core.Sprint[];
  expect(sprints.map(s => [s.number, s.phase, s.rolloverFromSprintId])).toEqual([[sprint.number, "ended", null], [sprint.number + 1, "active", sprint.id]]);
});

test("startServer は間隔ごとに引き継ぎ、変更したときだけ購読者へ change を送る", async () => {
  const dbPath = join(tempDir(), "nod.db");
  // data_version の確認を止め、change が自動処理の通知だけから来るようにする
  const server = startServer({ port: 0, dbPath, pollIntervalMs: 3_600_000, rolloverIntervalMs: 50 });
  running.push(server);
  const sse = sseReader(await fetch(`${server.url}/api/events`));
  expect((await sse.next())?.event).toBe("ready");
  expect(await sse.next(300)).toBeNull();

  const other = core.openDb(dbPath);
  const ws = core.initWorkspace(other, { path: "/tmp/repos/api-server" }).workspace;
  const sprint = activeSprint(other, ws.key, ws.id);
  other.close();
  expect((await sse.next(2000))?.event).toBe("change");
  const previous = await (await fetch(`${server.url}/api/sprints/${sprint.id}`)).json() as core.SprintDetail;
  expect(previous).toMatchObject({ phase: "ended", rolloverTo: { number: sprint.number + 1, phase: "active" } });
  expect(await sse.next(300)).toBeNull();
  await sse.cancel();
});

test("Scrum設定に自動引継ぎの値を含め、状態をルートの時計で読み、人が設定を変える", async () => {
  const { db, ws } = setup();
  const sprint = activeSprint(db, ws.key, ws.id);
  const app = createApp({ db, sprintClock: { now: new Date("2020-01-08T00:00:00.000Z") } });

  expect((await call(app, "GET", `/api/workspaces/${ws.key}/scrum`)).json).toMatchObject({ enabled: true, autoRollover: true });
  const status = await call(app, "GET", `/api/workspaces/${ws.key}/scrum/rollover`);
  expect(status).toMatchObject({ status: 200, json: { workspaceKey: ws.key, enabled: true, scrumEnabled: true, nextRunAt: sprint.endsAt,
    successor: { kind: "create", startDate: "2020-01-13", endDate: "2020-01-19", timezone: "Asia/Tokyo" }, blocked: null } });
  // 状態の読取は変更しない
  expect(core.getSprint(db, sprint.id).phase).toBe("active");

  expect((await call(app, "PUT", `/api/workspaces/${ws.key}/scrum/rollover`, { enabled: false, actor: "codex" })).status).toBe(400);
  const off = await call(app, "PUT", `/api/workspaces/${ws.key}/scrum/rollover`, { enabled: false });
  expect(off).toMatchObject({ status: 200, json: { autoRollover: false } });
  expect((await call(app, "GET", `/api/workspaces/${ws.key}/scrum`)).json.autoRollover).toBe(false);
  expect((await call(app, "GET", `/api/workspaces/${ws.key}/scrum/rollover`)).json).toMatchObject({ enabled: false, blocked: { code: "SPRINT_ROLLOVER_DISABLED" } });
  db.close();
});
