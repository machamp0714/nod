import { expect, test } from "bun:test";
import * as core from "../src/index";
import { codeOf, setup } from "./helpers";
import { acceptPreparedSprint, prepareSprint, sprintTestClock } from "./fixtures/sprint-start";

test("readyの採択Issueも通常suggest/nextで優先度順に選ばれ、続けて採択外の仕事を取得できる", () => {
  const { db, ws, me, llm } = setup();
  const adopted = core.createIssue(me, { workspaceId: ws.id, title: "採択", priority: 1 });
  const ordinary = core.createIssue(me, { workspaceId: ws.id, title: "通常", priority: 4 });
  acceptPreparedSprint(me, prepareSprint(me, ws.key, [adopted.id]));
  expect(core.suggestIssue(llm, { workspaceId: ws.id })?.id).toBe(adopted.id);
  expect(core.nextIssue(llm, { workspaceId: ws.id })?.id).toBe(adopted.id);
  expect(core.getIssue(db, adopted.id)).toMatchObject({ status: "in_progress", assignee: "claude-code", agentState: "working" });
  expect(core.nextIssue(llm, { workspaceId: ws.id })?.id).toBe(ordinary.id);
  expect(core.nextIssue(llm, { workspaceId: ws.id })).toBeNull();
  db.close();
});

test("採択後の要求変更・アーカイブ・削除を実行候補にせず、進捗とコメントでは要求を変えず、要求変更後も通常startできる", () => {
  const { db, ws, me, llm } = setup();
  const adopted = core.createIssue(me, { workspaceId: ws.id, title: "採択", description: "当初の要求" });
  const prepared = prepareSprint(me, ws.key, [adopted.id]);
  let ready = acceptPreparedSprint(me, prepared);
  let sprint = core.activateSprint(me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  const check = () => core.getSprintIssueEligibility(llm, sprint.id, prepared.items[0]!.id, sprintTestClock);
  core.commentIssue(llm, adopted.id, "進捗を追記");
  core.setPlanTasks(llm, adopted.id, ["既存の計画を分割する"]);
  expect(check().eligible).toBe(true);
  core.updateIssue(me, adopted.id, { description: "変更した要求" });
  expect(check()).toMatchObject({ eligible: false, reason: { code: "TARGET_CHANGED" } });
  expect(core.suggestIssue(llm, { workspaceId: ws.id })?.id).toBe(adopted.id);
  expect(core.startIssue(llm, adopted.id)).toMatchObject({ status: "in_progress", assignee: "claude-code" });
  const revised = core.proposeSprintPlan(llm, sprint.id, { ...prepared.input, expectedVersion: sprint.version, requestKey: "新要求", changeReason: "要求を変更" });
  expect(check()).toMatchObject({ eligible: false, planId: ready.plan.id, reason: { code: "TARGET_CHANGED" } });
  expect(codeOf(() => core.acceptSprintPlan(me, sprint.id, revised.plan.id, { expectedVersion: sprint.version, requestKey: "古い版", contentHash: revised.plan.contentHash }))).toBe("STALE_REVISION");
  ready = core.acceptSprintPlan(me, sprint.id, revised.plan.id, { expectedVersion: revised.sprint.version, requestKey: "新要求合意", contentHash: revised.plan.contentHash });
  sprint = ready.sprint;
  expect(check()).toMatchObject({ eligible: true, planId: revised.plan.id });
  core.archiveIssue(me, adopted.id);
  expect(check()).toMatchObject({ eligible: false, reason: { code: "ISSUE_ARCHIVED" } });
  core.deleteIssue(me, adopted.id);
  expect(check()).toMatchObject({ eligible: false, issueId: null, reason: { code: "TARGET_CHANGED" } });
  const replacement = core.createIssue(me, { workspaceId: ws.id, title: "別Issue" });
  expect(check().eligible).toBe(false);
  expect(core.startIssue(llm, replacement.id).status).toBe("in_progress");
  db.close();
});

test("一般更新と一括更新で採択Issueをin_progressにでき、採択外Issueの手動更新の意味も変わらない", () => {
  const { db, ws, me, llm } = setup();
  const adopted = core.createIssue(me, { workspaceId: ws.id, title: "採択" });
  const ordinary = core.createIssue(me, { workspaceId: ws.id, title: "通常" });
  const ready = acceptPreparedSprint(me, prepareSprint(me, ws.key, [adopted.id]));
  for (const ctx of [me, llm]) {
    expect(core.updateIssue(ctx, adopted.id, { status: "in_progress", assignee: ctx.actor })).toMatchObject({ status: "in_progress", assignee: ctx.actor });
    core.updateIssue(me, adopted.id, { status: "todo", assignee: null });
  }
  // 採択外の手動更新は、未回答・他担当があっても従来の移動の意味を維持する。
  core.askQuestion(llm, ordinary.id, "仕様を選んでください");
  expect(core.updateIssue(me, ordinary.id, { status: "in_progress", assignee: "other" })).toMatchObject({ status: "in_progress", assignee: "other", agentState: null });
  core.activateSprint(me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  expect(core.bulkUpdateIssues(me, [ordinary.id, adopted.id], { status: "in_progress", assignee: "me", priority: 1 }))
    .toMatchObject([{ id: ordinary.id, status: "in_progress", assignee: "me", priority: 1 }, { id: adopted.id, status: "in_progress", assignee: "me", priority: 1 }]);
  expect(core.updateIssue(me, adopted.id, { priority: 2, assignee: "me" })).toMatchObject({ priority: 2, assignee: "me", status: "in_progress" });
  db.close();
});

test("ready/activeの採択Issueは同actorの再開startに成功し、他担当のstartは従来どおり拒否し、追加の引数があっても通常startとして扱う", () => {
  const { db, ws, me, llm } = setup();
  const adopted = core.createIssue(me, { workspaceId: ws.id, title: "採択" });
  core.startIssue(llm, adopted.id);
  const ready = acceptPreparedSprint(me, prepareSprint(me, ws.key, [adopted.id]));
  expect(core.startIssue(llm, adopted.id)).toMatchObject({ status: "in_progress", assignee: "claude-code", agentState: "working" });
  core.activateSprint(me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  const activeBefore = core.getIssue(db, adopted.id);
  expect(codeOf(() => core.startIssue(me, adopted.id))).toBe("ASSIGNED_TO_OTHER");
  expect(core.getIssue(db, adopted.id)).toEqual(activeBefore);
  expect(core.startIssue(llm, adopted.id, { sprintId: ready.sprint.id, attemptId: "架空", location: { branch: "fake", worktree: "/tmp/fake" } } as any))
    .toMatchObject({ status: "in_progress", assignee: "claude-code", branch: "fake", worktree: "/tmp/fake" });
  db.close();
});

test("Sprint実行候補の公開判定は採択・合意・開始・timezoneの期間を要求し、通常startはこの判定と別に成功する", () => {
  const { db, ws, me, llm } = setup();
  const adopted = core.createIssue(me, { workspaceId: ws.id, title: "採択" });
  const candidate = core.createIssue(me, { workspaceId: ws.id, title: "候補だけ" });
  const proposed = prepareSprint(me, ws.key, [adopted.id]);
  const added = core.addIssueToSprint(me, proposed.sprint.id, { issueRef: candidate.id });
  const check = (itemId = proposed.items[0]!.id, clock = sprintTestClock) => core.getSprintIssueEligibility(llm, proposed.sprint.id, itemId, clock);
  expect(check()).toMatchObject({ eligible: false, reason: { code: "NOT_ACCEPTED" } });
  const ready = core.acceptSprintPlan(me, proposed.sprint.id, proposed.plan.id, { expectedVersion: added.sprint.version, requestKey: "合意", contentHash: proposed.plan.contentHash });
  expect(check()).toMatchObject({ eligible: false, reason: { code: "SPRINT_NOT_ACTIVE" } });
  core.activateSprint(me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  expect(check()).toMatchObject({ sprintId: ready.sprint.id, planId: ready.plan.id, itemId: proposed.items[0]!.id, issueId: adopted.id, eligible: true, reason: null });
  // 所属しているが計画外のitemは、Sprint実行の対象にならない。
  expect(core.getIssue(db, candidate.id).sprints.map(s => [s.id, s.association])).toEqual([[ready.sprint.id, "added"]]);
  expect(check(added.item.id)).toMatchObject({ eligible: false, reason: { code: "NOT_ACCEPTED" } });
  expect(check(undefined, { now: new Date("2026-03-08T04:59:59.999Z") })).toMatchObject({ eligible: false, reason: { code: "SPRINT_NOT_ACTIVE" } });
  expect(check(undefined, { now: new Date("2026-03-09T03:59:59.999Z") }).eligible).toBe(true);
  expect(check(undefined, { now: new Date("2026-03-09T04:00:00.000Z") })).toMatchObject({ eligible: false, reason: { code: "SPRINT_EXPIRED" } });
  expect(core.startIssue(llm, adopted.id)).toMatchObject({ status: "in_progress", assignee: "claude-code" });
  db.close();
});

test("採択は依存・未回答・担当・triage・仕様判定・needs-spec・snooze・遷移規則を解除しない", async () => {
  const { db, ws, me, llm } = setup();
  core.setWorkspaceSpecAssessment(me, ws.key, true);
  const adopted = core.createIssue(me, { workspaceId: ws.id, title: "採択", description: "要求" });
  const prepared = prepareSprint(me, ws.key, [adopted.id]);
  const ready = acceptPreparedSprint(me, prepared);
  const sprint = core.activateSprint(me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  const check = (clock = sprintTestClock) => core.getSprintIssueEligibility(llm, sprint.id, prepared.items[0]!.id, clock);
  expect(check()).toMatchObject({ eligible: false, reason: { code: "SPEC_ASSESSMENT_REQUIRED" } });
  await core.assessCreatedIssue(me, adopted.id, async () => ({ kind: "failed", failureKind: "network", elapsedMs: 1 }));
  expect(check()).toMatchObject({ eligible: false, reason: { code: "SPEC_ASSESSMENT_REQUIRED" } });
  await core.retryIssueAssessment(me, adopted.id, async () => ({ kind: "success", probability: 0.9, model: "jev-1.13.0", inputTokens: 1, elapsedMs: 1 }));
  expect(check()).toMatchObject({ eligible: false, reason: { code: "NEEDS_SPEC" } });
  core.updateIssue(me, adopted.id, { removeLabels: ["needs-spec"] });
  expect(check().eligible).toBe(true);
  core.updateIssue(me, adopted.id, { assignee: "other" });
  expect(check()).toMatchObject({ eligible: false, reason: { code: "ASSIGNED_TO_OTHER" } });
  core.updateIssue(me, adopted.id, { assignee: null });
  const blocker = core.createIssue(me, { workspaceId: ws.id, title: "前提" });
  core.relateIssue(me, blocker.id, { blocks: adopted.id });
  expect(check()).toMatchObject({ eligible: false, reason: { code: "BLOCKED" } });
  core.updateIssue(me, blocker.id, { status: "done" });
  expect(check().eligible).toBe(true);
  core.askQuestion(llm, adopted.id, "判断が必要");
  expect(check()).toMatchObject({ eligible: false, reason: { code: "NEEDS_CLARIFICATION" } });
  core.updateIssue(me, adopted.id, { status: "todo" });
  expect(check()).toMatchObject({ eligible: false, reason: { code: "AWAITING_ANSWER" } });
  core.answerQuestion(me, adopted.id, "回答");
  core.setTransitionRules(me, ws.key, { forbidden: [{ from: "todo", to: "in_progress" }] });
  expect(check()).toMatchObject({ eligible: false, reason: { code: "TRANSITION_NOT_ALLOWED" } });
  core.resetTransitionRules(me, ws.key);
  core.updateIssue(me, adopted.id, { status: "triage" });
  expect(check()).toMatchObject({ eligible: false, reason: { code: "NOT_ACCEPTED" } });
  core.snoozeTriage(me, adopted.id, "2999-01-01T00:00:00Z");
  core.updateIssue(me, adopted.id, { status: "todo" });
  expect(check()).toMatchObject({ eligible: false, reason: { code: "ISSUE_SNOOZED" } });
  db.close();
});

test("Sprint運用を無効化した後も採択Issueを通常suggest・startでき、Sprintの新規の実行候補にはしない", () => {
  const { db, ws, me, llm } = setup();
  const issue = core.createIssue(me, { workspaceId: ws.id, title: "採択" });
  const prepared = prepareSprint(me, ws.key, [issue.id]);
  const ready = acceptPreparedSprint(me, prepared);
  core.activateSprint(me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  core.configureScrumWorkspace(me, ws.key, { expectedVersion: 1, requestKey: "無効化", enabled: false, problem: "重複着手", productGoal: "合意した仕事を進める", priorityRationale: "採択範囲を守る" });
  expect(core.getSprintIssueEligibility(llm, ready.sprint.id, prepared.items[0]!.id, sprintTestClock)).toMatchObject({ eligible: false, reason: { code: "SCRUM_DISABLED" } });
  expect(core.suggestIssue(llm, { workspaceId: ws.id })?.id).toBe(issue.id);
  expect(core.startIssue(me, issue.id)).toMatchObject({ status: "in_progress", assignee: "me" });
  db.close();
});

test("active中の未合意追加を採用中の集合へ混ぜず、同じ候補でも合意された版に追従し、通常の候補・着手・更新は優先度順に通る", () => {
  const { db, ws, me, llm } = setup();
  const adopted = core.createIssue(me, { workspaceId: ws.id, title: "採択", priority: 1 });
  const candidate = core.createIssue(me, { workspaceId: ws.id, title: "候補だけ", priority: 2 });
  const outside = core.createIssue(me, { workspaceId: ws.id, title: "採択外", priority: 3 });
  const prepared = prepareSprint(me, ws.key, [adopted.id]);
  const ready = acceptPreparedSprint(me, prepared);
  const active = core.activateSprint(me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  const added = core.addIssueToSprint(me, active.id, { issueRef: candidate.id });
  expect(core.queryIssues(db, { sprint: active.id }).issues.map(i => i.id).sort()).toEqual([adopted.id, candidate.id].sort());
  const changed = core.proposeSprintPlan(llm, active.id, { ...prepared.input, expectedVersion: added.sprint.version, requestKey: "未合意追加", items: [...prepared.input.items, { itemId: added.item.id, contribution: "追加の貢献", executionPlan: "追加実装" }], changeReason: "範囲追加" });
  expect(core.getSprintIssueEligibility(llm, active.id, prepared.items[0]!.id, sprintTestClock)).toMatchObject({ eligible: true, planId: ready.plan.id });
  expect(core.getSprintIssueEligibility(llm, active.id, added.item.id, sprintTestClock)).toMatchObject({ eligible: false, reason: { code: "NOT_ACCEPTED" } });
  expect(core.suggestIssue(llm, { workspaceId: ws.id })?.id).toBe(adopted.id);
  expect(core.startIssue(llm, adopted.id)).toMatchObject({ status: "in_progress", assignee: "claude-code" });
  expect(core.suggestIssue(llm, { workspaceId: ws.id })?.id).toBe(candidate.id);
  const newReady = core.acceptSprintPlan(me, active.id, changed.plan.id, { expectedVersion: changed.sprint.version, requestKey: "追加合意", contentHash: changed.plan.contentHash });
  expect(core.getSprintIssueEligibility(llm, active.id, added.item.id, sprintTestClock)).toMatchObject({ eligible: true, planId: newReady.plan.id });
  expect(core.suggestIssue(llm, { workspaceId: ws.id })?.id).toBe(candidate.id);
  expect(core.updateIssue(me, candidate.id, { status: "in_progress" })).toMatchObject({ status: "in_progress" });
  expect(core.suggestIssue(llm, { workspaceId: ws.id })?.id).toBe(outside.id);
  const canceled = core.cancelSprint(me, active.id, { expectedVersion: newReady.sprint.version, requestKey: "中止", reason: "優先順位変更" });
  expect(core.getSprintIssueEligibility(llm, active.id, added.item.id, sprintTestClock)).toMatchObject({ eligible: false, reason: { code: "SPRINT_NOT_ACTIVE" } });
  expect(core.startIssue(llm, adopted.id).status).toBe("in_progress");
  expect(canceled.phase).toBe("canceled");
  db.close();
});
