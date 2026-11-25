import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "@nod/core";
import { makeRepo, runNod, tempDb, tempDir } from "./helpers";

// 分岐の網羅は core の sprint-rollover.test.ts にある。ここでは CLI の共通入口の配線だけを確かめる。
// 期間は過去の日付で作り、実時計で処理させる。
function expiredActiveSprint(cwd: string, db: string) {
  const d = core.openDb(db);
  try {
    const ws = core.initWorkspace(d, { path: cwd }).workspace;
    const me = { db: d, actor: core.HUMAN_ACTOR }, llm = { db: d, actor: "codex" };
    core.configureScrumWorkspace(me, ws.key, { expectedVersion: 0, requestKey: "設定", enabled: true, problem: "停滞", productGoal: "進める", priorityRationale: "判断を優先" });
    const created = core.createSprint(llm, { workspaceKey: ws.key, name: "過去のSprint", startDate: "2020-01-06", endDate: "2020-01-12", timezone: "Asia/Tokyo",
      expectedVersion: 0, requestKey: "作成" });
    const open = core.createIssue(me, { workspaceId: ws.id, title: "未完了" });
    core.addIssueToSprint(llm, created.id, { issueRef: open.id });
    const proposed = core.proposeSprintPlan(llm, created.id, { expectedVersion: created.version, requestKey: "計画", goal: "前のゴール", verificationMethod: "確認する",
      items: [], definitionOfDone: [{ id: "前", text: "前の完成の定義" }], constraints: { executionScope: "WS", notes: "なし" }, changeReason: "最初の提案" });
    const ready = core.acceptSprintPlan(me, created.id, proposed.plan.id, { expectedVersion: proposed.sprint.version, requestKey: "合意", contentHash: proposed.plan.contentHash });
    const sprint = core.activateSprint(me, created.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, { now: new Date(created.startsAt!) });
    return { ws, sprint, open };
  } finally {
    d.close();
  }
}

test("DBを開くコマンドの実行前に期限切れのSprintを引き継ぎ、--jsonの標準出力は壊さない", async () => {
  const cwd = makeRepo(), db = tempDb();
  const { sprint, open } = expiredActiveSprint(cwd, db);

  const listed = await runNod(["sprint", "list", "--json"], { cwd, db, actor: "codex" });
  expect(listed.exitCode).toBe(0);
  expect(listed.stderr).toBe("");
  expect(JSON.parse(listed.stdout).map((s: any) => [s.number, s.phase])).toEqual([[sprint.number, "ended"], [sprint.number + 1, "active"]]);

  const previous = (await runNod(["sprint", "show", sprint.id, "--json"], { cwd, db })).json;
  expect(previous).toMatchObject({ phase: "ended", rolloverFrom: null, rolloverTo: { number: sprint.number + 1, phase: "active" },
    closureRecord: { automation: "sprint-rollover", recordedBy: "nod-automation", issues: [{ issueId: open.id }] } });
  const successor = (await runNod(["sprint", "show", String(sprint.number + 1), "--json"], { cwd, db })).json;
  expect(successor).toMatchObject({ phase: "active", activatedBy: core.SPRINT_ROLLOVER_ACTOR, rolloverFrom: { id: sprint.id },
    items: [{ sourceIssueKey: open.id, member: true, addedBy: core.SPRINT_ROLLOVER_ACTOR, rolloverFromItemId: previous.items[0].id }] });

  const previousText = (await runNod(["sprint", "show", sprint.id], { cwd, db })).stdout;
  expect(previousText).toContain(`後継のSprint: Sprint ${sprint.number + 1}「Sprint ${sprint.number + 1}」（active）`);
  expect(previousText).toContain(`自動終了: 期間の終了時刻 ${sprint.endsAt}  記録時刻 ${previous.closureRecord.recordedAt}`);
  expect(previousText).toContain("記録者: nod-automation");
  const input = join(tempDir(), "end.json");
  writeFileSync(input, JSON.stringify({ expectedVersion: previous.version, requestKey: "手動終了", reason: "確認" }));
  const rejected = await runNod(["sprint", "end", sprint.id, "--input", input], { cwd, db, actor: "codex" });
  expect(rejected.exitCode).not.toBe(0);
  expect(rejected.stderr).toContain("自動処理で終了し");
  expect((await runNod(["sprint", "show", sprint.id, "--json"], { cwd, db })).json.closureRecord).toEqual(previous.closureRecord);
  const successorText = (await runNod(["sprint", "show", String(sprint.number + 1)], { cwd, db })).stdout;
  expect(successorText).toContain(`前のSprint: Sprint ${sprint.number}「過去のSprint」（ended）`);
  expect(successorText).toContain(`自動開始: ${successor.activatedAt}（${core.SPRINT_ROLLOVER_ACTOR}）`);
  expect(successorText).toContain(`引継ぎ（Sprint ${sprint.number}「過去のSprint」（ended）から）`);
});

test("以前に開始者が記録されなかったSprintは、CLIで開始日時と記録なしを示す", async () => {
  const cwd = makeRepo(), db = tempDb();
  const { sprint, ws } = expiredActiveSprint(cwd, db);
  const d = core.openDb(db);
  core.setSprintRollover({ db: d, actor: "me" }, ws.key, { enabled: false });
  d.query("UPDATE sprints SET activated_by=NULL WHERE id=?").run(sprint.id);
  d.close();

  const opts = { cwd, db, actor: "codex" };
  const shown = await runNod(["sprint", "show", sprint.id, "--json"], opts);
  expect(shown.json).toMatchObject({ activatedAt: sprint.activatedAt, activatedBy: null });
  const text = (await runNod(["sprint", "show", sprint.id], opts)).stdout;
  expect(text).toContain(`開始: ${sprint.activatedAt}（記録なし）`);
  expect(text).not.toContain("自動開始");
});

test("nod scrum rollover はLLMも切り替えられ、nod scrum show に設定と状態が出る", async () => {
  const cwd = makeRepo(), db = tempDb();
  const { sprint } = expiredActiveSprint(cwd, db);

  const shown = await runNod(["scrum", "show", "--json"], { cwd, db, actor: "codex" });
  expect(shown.json).toMatchObject({ enabled: true, autoRollover: true,
    rollover: { enabled: true, scrumEnabled: true, successor: { kind: "create", timezone: "Asia/Tokyo" }, blocked: null } });
  // 引継ぎ後は、自動で開始した後継の終了時刻が次に処理する時刻になる
  const successor = (await runNod(["sprint", "show", String(sprint.number + 1), "--json"], { cwd, db })).json;
  expect(shown.json.rollover.nextRunAt).toBe(successor.endsAt);

  const off = await runNod(["scrum", "rollover", "off", "--json"], { cwd, db, actor: "codex" });
  expect(off.exitCode).toBe(0);
  expect(off.json.autoRollover).toBe(false);
  const after = await runNod(["scrum", "show", "--json"], { cwd, db, actor: "codex" });
  expect(after.json).toMatchObject({ autoRollover: false, rollover: { enabled: false, blocked: { code: "SPRINT_ROLLOVER_DISABLED" } } });
  const text = (await runNod(["scrum", "show"], { cwd, db })).stdout;
  expect(text).toContain("自動引継ぎ: 無効");
  expect(text).toContain("止まっている理由: 期限到来時の自動引継ぎは無効に設定されています");
  expect((await runNod(["scrum", "rollover", "on"], { cwd, db, actor: "codex" })).stdout).toContain("期限到来時の自動引継ぎを有効にしました");
});

test.each(["me", "codex"])("%s はCLIで手動終了したSprintの記録者になる", async (actor) => {
  const cwd = makeRepo(), db = tempDb();
  const { sprint, ws } = expiredActiveSprint(cwd, db);
  const d = core.openDb(db);
  core.setSprintRollover({ db: d, actor: "me" }, ws.key, { enabled: false });
  d.close();
  const input = join(tempDir(), "end.json");
  writeFileSync(input, JSON.stringify({ expectedVersion: sprint.version, requestKey: "終了", reason: "期限に到達" }));
  const ended = await runNod(["sprint", "end", sprint.id, "--input", input, "--json"], { cwd, db, actor });
  expect(ended).toMatchObject({ exitCode: 0, json: { phase: "ended" } });
  const shown = await runNod(["sprint", "show", sprint.id, "--json"], { cwd, db, actor: "codex" });
  expect(shown.json.closureRecord).toMatchObject({ reason: "期限に到達", kind: "ended", recordedBy: actor });
  expect((await runNod(["sprint", "show", sprint.id], { cwd, db })).stdout).toContain(`記録者: ${actor}`);
});

test.each(["me", "codex"])("%s はCLIで中止したSprintの記録者になる", async (actor) => {
  const cwd = makeRepo(), db = tempDb();
  const { sprint, ws } = expiredActiveSprint(cwd, db);
  const d = core.openDb(db);
  core.setSprintRollover({ db: d, actor: "me" }, ws.key, { enabled: false });
  d.close();
  const input = join(tempDir(), "cancel.json");
  writeFileSync(input, JSON.stringify({ expectedVersion: sprint.version, requestKey: "中止", reason: "優先順位の変更" }));
  const canceled = await runNod(["sprint", "cancel", sprint.id, "--input", input, "--json"], { cwd, db, actor });
  expect(canceled).toMatchObject({ exitCode: 0, json: { phase: "canceled" } });
  const shown = await runNod(["sprint", "show", sprint.id, "--json"], { cwd, db });
  expect(shown.json.closureRecord).toMatchObject({ reason: "優先順位の変更", kind: "canceled", recordedBy: actor });
  expect((await runNod(["sprint", "show", sprint.id], { cwd, db })).stdout).toContain(`記録者: ${actor}`);
});

test("CLIは手動終了の記録者と後継の自動開始者を別々に表示する", async () => {
  const cwd = makeRepo(), db = tempDb();
  const { sprint } = expiredActiveSprint(cwd, db);
  // CLIの終了コマンドは本体より先に自動処理するため、手動引継ぎは先に用意する。
  const d = core.openDb(db);
  core.endSprint({ db: d, actor: "codex" }, sprint.id, {
    expectedVersion: sprint.version, requestKey: "手動引継ぎ", reason: "期間の終了",
  });
  d.close();
  const opts = { cwd, db, actor: "omp" };
  const previous = (await runNod(["sprint", "show", sprint.id, "--json"], opts)).json;
  expect(previous.closureRecord.recordedBy).toBe("codex");
  expect(previous.closureRecord.automation).toBeUndefined();
  const successor = (await runNod(["sprint", "show", previous.rolloverTo.id, "--json"], opts)).json;
  expect(successor).toMatchObject({ phase: "active", activatedBy: "nod-automation" });
});

test.each([
  ["手動終了", null, "記録なし"],
  ["自動終了", "sprint-rollover", "nod-automation"],
])("CLIは記録者のない旧版の%sを表示する", async (_, automation, actorLabel) => {
  const cwd = makeRepo(), db = tempDb();
  const { sprint } = expiredActiveSprint(cwd, db);
  const d = core.openDb(db);
  const closure = { kind: "ended", reason: "旧版で終了", recordedAt: sprint.endsAt,
    issues: [], questions: [], ...(automation ? { automation } : {}) };
  d.query("UPDATE sprints SET phase='ended', closure_record=? WHERE id=?").run(JSON.stringify(closure), sprint.id);
  d.close();
  const opts = { cwd, db, actor: "omp" };
  expect((await runNod(["sprint", "show", sprint.id, "--json"], opts)).json.closureRecord).toEqual(closure);
  expect((await runNod(["sprint", "show", sprint.id], opts)).stdout).toContain(`記録者: ${actorLabel}`);
});
