import * as core from "../../src/index";

export const sprintTestClock = { now: new Date("2026-03-08T12:00:00.000Z") };

// 計画を公開操作で準備する。core / CLI / HTTPで同じ採択条件を使う。
export function prepareSprint(ctx: core.OpCtx, workspaceKey: string, issueRefs: string[]) {
  core.configureScrumWorkspace(ctx, workspaceKey, {
    enabled: true, problem: "重複着手", productGoal: "合意した仕事を進める", priorityRationale: "採択範囲を守る",
    expectedVersion: 0, requestKey: "設定",
  });
  let sprint = core.createSprint(ctx, {
    workspaceKey, startDate: "2026-03-08", endDate: "2026-03-08", timezone: "America/New_York",
    expectedVersion: 0, requestKey: "作成",
  });
  const items: core.SprintItem[] = [];
  for (const issueRef of issueRefs) {
    const added = core.addSprintCandidate(ctx, sprint.id, { issueRef, expectedVersion: sprint.version, requestKey: `候補:${issueRef}` });
    sprint = added.sprint;
    items.push(added.item);
  }
  const input = {
    expectedVersion: sprint.version, requestKey: "計画", goal: "合意した範囲を実行する", verificationMethod: "公開操作で確認する",
    items: items.map(item => ({ itemId: item.id, contribution: "重複着手を防ぐ", executionPlan: "着手条件を確認する" })),
    definitionOfDone: [{ id: "着手", text: "採択範囲と既存条件を守る" }],
    constraints: { executionScope: "Workspace", maxParallel: 1, notes: "人の合意を守る" }, changeReason: "最初の計画",
  };
  const proposed = core.proposeSprintPlan(ctx, sprint.id, input);
  return { ...proposed, items, input };
}

export function acceptPreparedSprint(ctx: core.OpCtx, prepared: ReturnType<typeof prepareSprint>) {
  return core.acceptSprintPlan(ctx, prepared.sprint.id, prepared.plan.id, {
    expectedVersion: prepared.sprint.version, requestKey: "合意", contentHash: prepared.plan.contentHash,
  });
}
