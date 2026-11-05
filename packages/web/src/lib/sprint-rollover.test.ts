import { expect, test } from "bun:test";
import * as core from "@nod/core";
import { setup } from "../../../core/test/helpers";
import { sprintAssociationLabel } from "./sprints";
import { carriedItems, isAutoStarted, rolloverSuccessorPlan, SPRINT_AUTOMATION_ACTOR, sprintAgreementText, sprintLinkLabel } from "./sprint-rollover";

const tz = "Asia/Tokyo";
const afterEnd = { now: new Date("2026-11-03T00:00:00.000Z") };

// 人の合意・開始を経た実行中Sprint（2026-10-26〜2026-11-01）。Issueは直接追加で所属させる
function rolledOver() {
  const f = setup();
  core.configureScrumWorkspace(f.me, f.ws.key, { expectedVersion: 0, requestKey: "設定", enabled: true, problem: "停滞", productGoal: "進める", priorityRationale: "判断" });
  const created = core.createSprint(f.llm, { startDate: "2026-10-26", endDate: "2026-11-01", timezone: tz, workingDays: [1, 2, 3, 4, 5], workspaceKey: f.ws.key, expectedVersion: 0, requestKey: "作成" });
  const open = core.createIssue(f.me, { workspaceId: f.ws.id, title: "未完了" });
  const done = core.createIssue(f.me, { workspaceId: f.ws.id, title: "完了済み" });
  for (const issue of [open, done]) core.addIssueToSprint(f.llm, created.id, { issueRef: issue.id });
  const proposed = core.proposeSprintPlan(f.llm, created.id, { expectedVersion: created.version, requestKey: "計画", goal: "前のゴール", verificationMethod: "確認する",
    items: [], definitionOfDone: [{ id: "前", text: "前の完成の定義" }], constraints: { executionScope: "WS", notes: "なし" }, changeReason: "最初の提案" });
  const ready = core.acceptSprintPlan(f.me, created.id, proposed.plan.id, { expectedVersion: proposed.sprint.version, requestKey: "合意", contentHash: proposed.plan.contentHash });
  const previous = core.activateSprint(f.me, created.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, { now: new Date(created.startsAt!) });
  core.updateIssue(f.me, done.id, { status: "done" });
  return { f, previous, open, done };
}

test("画面の自動処理の主体は core の自動引継ぎの主体と同じ値にする", () => {
  expect(SPRINT_AUTOMATION_ACTOR).toBe(core.SPRINT_ROLLOVER_ACTOR);
});

test("後継の予定は、既存のSprint・開始待ち・新規作成の期間・予定なしを区別する", () => {
  const sprint = { id: "uuid-5", number: 5, name: "次の期間", phase: "draft" as const };
  expect(rolloverSuccessorPlan({ kind: "existing", sprint })).toEqual({ text: "既存のSprintを後継にする", sprint });
  expect(rolloverSuccessorPlan({ kind: "start", sprint })).toEqual({ text: "後継の開始を待っている", sprint });
  expect(rolloverSuccessorPlan({ kind: "create", startDate: "2026-11-02", endDate: "2026-11-08", timezone: tz }))
    .toEqual({ text: "新しいSprintを作成する（2026-11-02〜2026-11-08、Asia/Tokyo）", sprint: null });
  expect(rolloverSuccessorPlan(null)).toEqual({ text: "予定なし", sprint: null });
  expect(sprintLinkLabel(sprint)).toBe("Sprint 5「次の期間」");
});

test("実行中Sprintの状態から、作成する後継の期間を予定として出す", () => {
  const { f } = rolledOver();
  try {
    const status = core.getSprintRolloverStatus(f.db, f.ws.key, { now: new Date("2026-10-30T00:00:00.000Z") });
    expect(status.nextRunAt).toBe("2026-11-01T15:00:00.000Z");
    expect(rolloverSuccessorPlan(status.successor).text).toBe("新しいSprintを作成する（2026-11-02〜2026-11-08、Asia/Tokyo）");
  } finally { f.db.close(); }
});

test("自動開始した計画の無い後継は合意を「なし」と出し、人が合意して開始したSprintとは分ける", () => {
  const { f, previous } = rolledOver();
  try {
    core.syncSprintRollover(f.db, afterEnd);
    const ended = core.getSprint(f.db, previous.id);
    const successor = core.getSprint(f.db, ended.rolloverTo!.id);
    expect(isAutoStarted(successor)).toBe(true);
    expect(sprintAgreementText(successor)).toBe("なし（自動開始。計画は後から提案・合意できます）");
    expect(isAutoStarted(ended)).toBe(false);
    expect(sprintAgreementText(ended)).toBe("採用計画あり");
    expect(sprintAgreementText({ adoptedPlanId: null, activatedBy: null })).toBe("不明");
  } finally { f.db.close(); }
});

test("引継ぎで入ったIssueは未完了のものだけで、Issueの Sprint 一覧には前Sprintと後継の両方が「追加」として出る", () => {
  const { f, previous, open } = rolledOver();
  try {
    core.syncSprintRollover(f.db, afterEnd);
    const ended = core.getSprint(f.db, previous.id);
    const successor = core.getSprint(f.db, ended.rolloverTo!.id);
    expect(carriedItems(successor).map((item) => item.sourceIssueKey)).toEqual([open.id]);
    expect(carriedItems(ended)).toEqual([]);
    const sprints = core.getIssue(f.db, open.id).sprints;
    expect(sprints.map((sprint) => [sprint.id, sprintAssociationLabel(sprint.association)])).toEqual([[previous.id, "追加"], [successor.id, "追加"]]);
  } finally { f.db.close(); }
});
