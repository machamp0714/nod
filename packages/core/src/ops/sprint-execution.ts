import type { Database } from "bun:sqlite";
import type { OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { SprintOrcaMutationError, sameSprintCaller } from "../sprint-execution-types";
import { sprintHash, sprintObject, sprintText, sprintVersion } from "../sprint-validation";
import type { SprintClock, SprintDetail, SprintPlan } from "../sprint-types";
import type { PrepareSprintExecutionInput, SprintAttempt, SprintExecutionOperation, SprintExecutionState,
  SprintOrcaAdapter, SprintRunAuthority, SprintSession, SprintSessionContext, SprintSessionInput, SprintExecutionReceipt,
  SprintOrcaInventory, SprintRequestObservation, SprintExecutionSnapshot, SprintExistingOwnership } from "../sprint-execution-types";
import { getSprint } from "./sprints";
import { getSprintIssueEligibility } from "./sprint-eligibility";
import { findIssueRow } from "../issue-query";
import type { SprintHostObservation, SprintOrcaHostObservation, SprintOrcaStatusMessage, SprintSettingsRequirement, SprintStartConfirmation } from "../sprint-observation-types";
import type { SprintNotificationState, SprintNotificationResult, SprintNotificationReception, SprintNotificationDelivery, SprintNotificationInput, SprintOrcaDelivery, SprintNotificationReleaseOperation } from "../sprint-notification-types";
import type { SprintSelfMetadata } from "../sprint-self-metadata";

const missingObservation = { code: "HOST_OBSERVATION_REQUIRED", message: "担当の実行設定と現在の実行identityを確認してください" };
function fail(code: string, message: string): never { throw new NodError(code, message); }
function timestamp(clock: SprintClock): string { return (clock.now ?? new Date()).toISOString(); }
function fresh(at: string, clock: SprintClock): boolean {
  const age = Date.parse(timestamp(clock)) - Date.parse(at);
  return Number.isFinite(age) && age >= 0 && age <= 120_000;
}
function session(db: Database, sprintId: string): SprintSession | null {
  const row = db.query("SELECT payload FROM sprint_sessions WHERE sprint_id=?").get(sprintId) as { payload: string } | null;
  return row ? JSON.parse(row.payload) : null;
}
function storeSession(db: Database, value: SprintSession): void {
  db.query(`INSERT INTO sprint_sessions VALUES(?,?,?,?) ON CONFLICT(sprint_id) DO UPDATE SET
    id=excluded.id,generation=excluded.generation,payload=excluded.payload`).run(value.id, value.sprintId, value.generation, JSON.stringify(value));
}
function touch(db: Database, sprintId: string): void {
  db.query(`INSERT INTO sprint_execution_versions VALUES(?,1) ON CONFLICT(sprint_id) DO UPDATE SET version=version+1`).run(sprintId);
}
function version(db: Database, sprintId: string): number {
  return (db.query("SELECT version FROM sprint_execution_versions WHERE sprint_id=?").get(sprintId) as { version: number } | null)?.version ?? 0;
}
function rows<T>(db: Database, table: string, sprintId: string): T[] {
  return (db.query(`SELECT payload FROM ${table} WHERE sprint_id=? ORDER BY rowid`).all(sprintId) as { payload: string }[]).map(r => JSON.parse(r.payload));
}
function owned(ctx: OpCtx, sprintId: string, input: SprintSessionContext, allowHandover = false): SprintSession {
  const current = session(ctx.db, sprintId);
  if (!current || current.id !== input.sessionId || current.generation !== input.generation || current.actor !== ctx.actor) fail("STALE_GENERATION", "現在の監督世代と一致しません。元Runを再照合してください");
  if (!allowHandover && current.state === "handover") fail("HANDOVER_PENDING", "監督の引継ぎ中です。元の操作と予約を再照合してください");
  return current;
}
function agreed(db: Database, ref: string) {
  const sprint = getSprint(db, ref);
  const plan = sprint.plans.find(p => p.id === sprint.adoptedPlanId);
  if (!plan || plan.agreedBy !== "me" || !plan.agreedAt || plan.contentHash !== plan.agreedHash) return fail("NOT_ACCEPTED", "採用中の合意済み計画を確認してください");
  return { sprint, plan };
}
// 通常経路の既存所有は試行として捏造しない。肯定的な対応を得るまで占有の写しを保つ。
function existingOwnership(db: Database, sprint: SprintDetail, attempts: SprintAttempt[],
  retained: SprintExistingOwnership[] = [], clock: SprintClock = {}): SprintExistingOwnership[] {
  const result = [...retained];
  const plan = sprint.plans.find(p => p.id === sprint.adoptedPlanId);
  if (!plan || plan.agreedBy !== "me" || !plan.agreedAt || plan.agreedHash !== plan.contentHash) return result;
  for (const selected of plan.content.items) {
    const item = sprint.items.find(i => i.id === selected.itemId);
    if (!item || item.issueId === null || attempts.some(a => a.itemId === item.id && !a.parentAttemptId)
      || result.some(a => a.itemId === item.id)) continue;
    const issue = findIssueRow(db, item.sourceIssueKey);
    if (issue.id !== item.issueId || !(issue.status === "in_progress" || issue.agent_state || issue.worktree || issue.branch)) continue;
    result.push({ itemId: item.id, sourceIssueKey: item.sourceIssueKey, issueId: item.issueId,
      assignee: issue.assignee, status: issue.status, worktree: issue.worktree, branch: issue.branch,
      observedAt: timestamp(clock), source: "採択Issueに保存された通常着手と実行場所",
      reason: { code: "EXISTING_EXECUTION_UNRECONCILED", message: "通常経路の所有と実行が未照合です。元の担当とTask・Dispatchを確認してください" } });
  }
  return result;
}
function planReconciliationReason(ctx: OpCtx, sprint: SprintDetail, plan: SprintPlan, attempts: SprintAttempt[],
  clock: SprintClock): SprintExecutionSnapshot["reason"] {
  const blocked = (code: string, message: string) => ({ code, message });
  if (sprint.phase !== "active") return blocked("SPRINT_NOT_ACTIVE", "新合意への照合は実行中のSprintで行ってください");
  const instant = Date.parse(timestamp(clock));
  if (!sprint.startsAt || instant < Date.parse(sprint.startsAt)) return blocked("SPRINT_NOT_ACTIVE", "Sprintの開始期間前です");
  if (!sprint.endsAt || instant >= Date.parse(sprint.endsAt)) return blocked("SPRINT_EXPIRED", "Sprintの期間は終了しています");
  if (sprintHash(plan.content) !== plan.contentHash) return blocked("TARGET_CHANGED", "新合意の内容とhashが一致しません");
  const config = ctx.db.query("SELECT enabled FROM scrum_workspaces WHERE workspace_id=?").get(sprint.workspaceId!) as { enabled: number } | null;
  if (!config?.enabled) return blocked("SCRUM_DISABLED", "WorkspaceのSprint運用が無効です");
  if (attempts.filter(a => !a.parentAttemptId).length > plan.content.constraints.maxParallel) return blocked("PARALLEL_LIMIT", "新合意の並行上限を予約が上回っています");
  for (const attempt of attempts) {
    const primary = attempt.parentAttemptId ? attempts.find(a => a.id === attempt.parentAttemptId)! : attempt;
    const eligibility = getSprintIssueEligibility({ ...ctx, actor: primary.actor }, sprint.id, attempt.itemId, clock);
    if (!eligibility.eligible) return eligibility.reason;
    const original = sprint.plans.find(p => p.id === attempt.planId && p.contentHash === attempt.planHash);
    const oldItem = original?.content.items.find(i => i.itemId === attempt.itemId);
    const newItem = plan.content.items.find(i => i.itemId === attempt.itemId);
    if (!original || !oldItem || !newItem || sprintHash(oldItem.requirement) !== sprintHash(newItem.requirement)) {
      return blocked("TARGET_CHANGED", "依頼済みの要求が新合意で変わっています。同じ担当と要求の対応を確認してください");
    }
    const inherited = plan.content.constraints.executionSettingsPolicy;
    if (inherited && (inherited.agent !== attempt.placement.agent
      || !inherited.allowedModels.includes(attempt.placement.model ?? attempt.hostObservation?.metadata.model ?? "")
      || !inherited.allowedEfforts.includes(attempt.placement.effort ?? attempt.hostObservation?.metadata.effort ?? "")
      || !inherited.allowedTargets.includes(attempt.placement.on ?? attempt.placement.worktree))) {
      return blocked("EXECUTION_SETTINGS_CHANGED", "元の要求設定が新合意の継承許可範囲と一致しません。元の試行を保持して現在の設定を照合してください");
    }
    for (const [key, actual] of [["executionTarget", attempt.placement.on ?? attempt.placement.worktree], ["model", attempt.placement.model], ["effort", attempt.placement.effort]] as const) {
      if (plan.content.constraints[key] !== undefined && plan.content.constraints[key] !== actual) {
        return blocked("EXECUTION_SETTINGS_CHANGED", "同じ担当の要求設定が新合意と一致しません。現在の配置と実行設定を確認してください");
      }
    }
  }
  return null;
}
function checkAuthority(value: SprintRunAuthority, runId: string, clock: SprintClock): void {
  if (value.runId !== runId || !value.caller || value.caller !== value.coordinator || !value.runtimeId
    || !Number.isSafeInteger(value.consumerGeneration) || value.consumerGeneration < 0 || !value.source || !fresh(value.observedAt, clock)) {
    fail("AUTHORITY_UNKNOWN", "元Runの現在の監督権限と取得時刻を確認できません");
  }
}
async function verifySprintSender(ctx: OpCtx, sprintId: string, input: SprintSessionContext,
  adapter: SprintOrcaAdapter, clock: SprintClock): Promise<void> {
  const owner = owned(ctx, sprintId, input);
  const authority = await adapter.authority(owner.runId);
  checkAuthority(authority, owner.runId, clock);
  const current = owned(ctx, sprintId, input);
  if (authority.caller !== current.caller || authority.runtimeId !== current.runtimeId
    || authority.consumerGeneration !== current.consumerGeneration || !sameSprintCaller(authority, current)) {
    fail("AUTHORITY_CHANGED", "送信直前の本人証拠・runtime・consumerが変わりました。元Runを再照合してください");
  }
}
export async function beginSprintSession(ctx: OpCtx, ref: string, input: SprintSessionInput, adapter: SprintOrcaAdapter, clock: SprintClock = {}): Promise<SprintSession> {
  sprintObject(input, ["expectedVersion", "requestKey", "runId"]);
  sprintVersion(input.expectedVersion); sprintText(input.requestKey, "要求キー"); sprintText(input.runId, "Run");
  const authority = await adapter.authority(input.runId);
  checkAuthority(authority, input.runId, clock);
  return tx(ctx.db, () => {
    const { sprint, plan } = agreed(ctx.db, ref);
    const inputHash = sprintHash({ actor: ctx.actor, input });
    const current = session(ctx.db, sprint.id);
    if (current) {
      if (current.requestKey === input.requestKey && current.inputHash === inputHash && current.caller === authority.caller
        && current.runtimeId === authority.runtimeId && current.consumerGeneration === authority.consumerGeneration && sameSprintCaller(current, authority)) return current;
      if (current.requestKey === input.requestKey && current.inputHash !== inputHash) return fail("IDEMPOTENCY_CONFLICT", "同じ要求キーの入力が異なります");
      return fail("EXECUTION_OWNED", "既存の監督が所有しています。session resumeで元Runへ合流してください");
    }
    if (sprint.version !== input.expectedVersion) fail("STALE_REVISION", "Sprintの版が変わっています");
    if (sprint.phase !== "active") fail("SPRINT_NOT_ACTIVE", "Sprintは実行中ではありません");
    const value: SprintSession = { schemaVersion: 1, id: crypto.randomUUID(), sprintId: sprint.id, generation: 1,
      runId: input.runId, actor: ctx.actor, caller: authority.caller, consumerGeneration: authority.consumerGeneration,
      runtimeId: authority.runtimeId, planId: plan.id, planHash: plan.contentHash, state: "active", requestKey: input.requestKey,
      inputHash, observedAt: authority.observedAt, source: authority.source, handover: null, callerIdentity: authority.callerIdentity,
      callerEvidence: authority.callerEvidence,
      unreconciledOwnership: existingOwnership(ctx.db, sprint, rows<SprintAttempt>(ctx.db, "sprint_attempts", sprint.id), [], clock) };
    storeSession(ctx.db, value); touch(ctx.db, sprint.id); return value;
  });
}
function storeAttempt(db: Database, value: SprintAttempt): void {
  db.query(`INSERT INTO sprint_attempts VALUES(?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`)
    .run(value.id, value.sprintId, value.itemId, value.sourceIssueKey, value.parentAttemptId, JSON.stringify(value));
}
function storeOperation(db: Database, value: SprintExecutionOperation): void {
  db.query(`INSERT INTO sprint_operations VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`)
    .run(value.id, value.sprintId, value.attemptId, value.kind, value.requestKey, JSON.stringify(value));
}
export function prepareSprintExecution(ctx: OpCtx, ref: string, input: PrepareSprintExecutionInput, clock: SprintClock = {}): SprintAttempt {
  sprintObject(input, ["sessionId", "generation", "requestKey", "itemId", "actor", "spec", "placement", "parentAttemptId"]);
  for (const key of ["sessionId", "requestKey", "itemId", "actor", "spec"] as const) sprintText(input[key], key);
  sprintVersion(input.generation);
  sprintObject(input.placement, ["worktree", "agent", "on", "model", "effort"]);
  sprintText(input.placement.worktree, "作業場所"); sprintText(input.placement.agent, "エージェント");
  for (const key of ["on", "model", "effort"] as const) if (input.placement[key] !== undefined) sprintText(input.placement[key], key);
  if (input.placement.effort && !input.placement.model) fail("INVALID_ARGS", "effortにはmodelの指定が必要です");
  return tx(ctx.db, () => {
    const { sprint, plan } = agreed(ctx.db, ref);
    const current = owned(ctx, sprint.id, input);
    // 世代は実行権限として毎回検査する。業務入力の同一性には監督の交代を含めない。
    const hash = sprintHash({ itemId: input.itemId, actor: input.actor, spec: input.spec,
      placement: input.placement, parentAttemptId: input.parentAttemptId ?? null });
    const prior = rows<SprintExecutionOperation>(ctx.db, "sprint_operations", sprint.id).find(o => o.kind === "task_create" && o.requestKey === input.requestKey);
    if (prior) {
      if (prior.inputHash !== hash) fail("IDEMPOTENCY_CONFLICT", "同じ要求キーの入力が異なります");
      return rows<SprintAttempt>(ctx.db, "sprint_attempts", sprint.id).find(a => a.id === prior.attemptId)!;
    }
    const eligibility = getSprintIssueEligibility({ ...ctx, actor: input.actor }, sprint.id, input.itemId, clock);
    if (!eligibility.eligible) fail(eligibility.reason!.code, eligibility.reason!.message);
    if (plan.id !== current.planId || plan.contentHash !== current.planHash) fail("TARGET_CHANGED", "監督が照合した計画と採用中の計画が異なります");
    const item = sprint.items.find(i => i.id === input.itemId)!;
    const attempts = rows<SprintAttempt>(ctx.db, "sprint_attempts", sprint.id);
    const parent = input.parentAttemptId ? attempts.find(a => a.id === input.parentAttemptId && a.parentAttemptId === null && a.itemId === item.id) : null;
    if (input.parentAttemptId && !parent) fail("INVALID_ARGS", "補助担当の親は同じ採択itemの主試行を指定してください");
    if (!parent) {
      if (ctx.db.query("SELECT 1 FROM sprint_attempts WHERE source_issue_key=? AND occupied=1 AND parent_attempt_id IS NULL").get(item.sourceIssueKey)) fail("EXECUTION_OWNED", "未解決の主試行が所有しています");
      const issue = findIssueRow(ctx.db, item.sourceIssueKey);
      if (issue.status === "in_progress" || issue.agent_state || issue.worktree || issue.branch) fail("EXECUTION_OWNED", "通常経路の着手または既存実行場所を先に照合してください");
      const existing = existingOwnership(ctx.db, sprint, attempts, current.unreconciledOwnership, clock);
      if (attempts.filter(a => !a.parentAttemptId).length + existing.length >= plan.content.constraints.maxParallel) fail("PARALLEL_LIMIT", "実行枠は予約と未照合の通常着手を含めて使用中です");
    }
    for (const [key, actual] of [["executionTarget", input.placement.on ?? input.placement.worktree], ["model", input.placement.model], ["effort", input.placement.effort]] as const) {
      const expected = plan.content.constraints[key];
      if (expected !== undefined && expected !== actual) fail("TARGET_CHANGED", "要求した配置・設定が合意と一致しません");
    }
    const attempt: SprintAttempt = { schemaVersion: 1, id: crypto.randomUUID(), sprintId: sprint.id, itemId: item.id,
      sourceIssueKey: item.sourceIssueKey, parentAttemptId: parent?.id ?? null, actor: input.actor, sessionId: current.id,
      generation: current.generation, planId: plan.id, planHash: plan.contentHash,
      decisionRefs: (ctx.db.query("SELECT id FROM questions WHERE issue_id=? AND answer IS NOT NULL ORDER BY id").all(item.issueId!) as { id: number }[])
        .map(question => `question:${question.id}`), runId: current.runId,
      taskId: null, dispatchId: null, placement: input.placement, phase: "reserved", occupied: true,
      canStart: false, reason: missingObservation, identity: null, observation: null,
      settingsRequirement: settingsRequirement(plan, input.placement) };
    const operation: SprintExecutionOperation = { schemaVersion: 1, id: crypto.randomUUID(), sprintId: sprint.id,
      attemptId: attempt.id, kind: "task_create", requestKey: input.requestKey, inputHash: hash, sessionId: current.id,
      generation: current.generation, caller: current.caller, callerIdentity: current.callerIdentity ?? null,
      callerEvidence: current.callerEvidence, consumerGeneration: current.consumerGeneration,
      runtimeId: current.runtimeId, runId: current.runId, state: "prepared",
      requestId: null, receipt: null, input: { spec: input.spec, placement: input.placement, taskId: null, parentTaskId: parent?.taskId ?? null }, reason: null };
    if (parent && !parent.taskId) fail("PARENT_NOT_READY", "主試行のTaskを照合してから補助担当を予約してください");
    storeAttempt(ctx.db, attempt); storeOperation(ctx.db, operation); touch(ctx.db, sprint.id); return attempt;
  });
}
export function getSprintExecutionState(db: Database, ref: string, clock: SprintClock = {}): SprintExecutionState {
  return tx(db, () => {
    const sprint = getSprint(db, ref), sprintId = sprint.id;
    const current = session(db, sprintId), attempts = rows<SprintAttempt>(db, "sprint_attempts", sprintId);
    const unreconciledOwnership = existingOwnership(db, sprint, attempts, current?.unreconciledOwnership, clock);
    if (current && unreconciledOwnership.length !== (current.unreconciledOwnership?.length ?? 0)) {
      current.unreconciledOwnership = unreconciledOwnership; storeSession(db, current); touch(db, sprintId);
    }
    for (const attempt of attempts.filter(a => a.canStart)) {
      const eligibility = getSprintIssueEligibility({ db, actor: attempt.actor }, sprintId, attempt.itemId, clock);
      if (!eligibility.eligible || !current || current.state !== "active" || attempt.startAuthorization?.generation !== current.generation
        || attempt.planId !== current.planId || attempt.planHash !== current.planHash || attempt.phase !== "start_authorized"
        || attempt.hostObservation?.result !== "matched" || !fresh(attempt.hostObservation.metadata.collectedAt, clock)) {
        attempt.canStart = false;
        attempt.reason = eligibility.reason ?? { code: "START_RECHECK_REQUIRED", message: "現在の監督・identity・設定を開始直前に再検査してください" };
      }
    }
    const plan = sprint.plans.find(p => p.id === sprint.adoptedPlanId && p.agreedBy === "me" && p.agreedAt && p.agreedHash === p.contentHash);
    const nextActions: Omit<SprintExecutionState["nextActions"][number], "command">[] = current ? [
      ...(sprint.adoptedPlanId && sprint.adoptedPlanId !== current.planId ? [{ description: "採用中の新合意と元の試行を照合して監督を再開する",
        argv: ["nod", "sprint", "session", "resume", sprintId, "--input", "-"],
        input: { sessionId: current.id, generation: current.generation, requestKey: current.handover?.requestKey ?? `plan:${sprint.adoptedPlanId}` } }] : []),
      ...unreconciledOwnership.map(a => ({ description: "元の担当と保存された通常着手・実行場所を確認する", argv: ["nod", "issue", "show", a.sourceIssueKey, "--json"] })),
      { description: "保存した主試行と元Runの要求・Task・Dispatchを照合する", argv: ["nod", "sprint", "execution", "reconcile", sprintId, "--input", "-"],
        input: { sessionId: current.id, generation: current.generation } }]
      : [{ description: "Sprintの計画と保存した実行対象を確認する", argv: ["nod", "sprint", "show", sprintId] }];
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    return { sprintId, observedAt: timestamp(clock), maxParallel: plan?.content.constraints.maxParallel ?? null, session: current, executionVersion: version(db, sprintId), attempts,
      operations: rows<SprintExecutionOperation>(db, "sprint_operations", sprintId), occupied: attempts.filter(a => !a.parentAttemptId).length + unreconciledOwnership.length,
      unreconciledOwnership,
      reserved: attempts.filter(a => !a.parentAttemptId).length, canStart: attempts.some(a => a.canStart),
      stale: current ? !fresh(current.observedAt, clock) : true,
      quarantined: rows(db, "sprint_execution_quarantine", sprintId),
      nextActions: nextActions.map(action => ({ ...action, command:
        `${action.input ? `printf '%s\\n' ${quote(JSON.stringify(action.input))} | ` : ""}${current ? `NOD_ACTOR=${quote(current.actor)} ` : ""}${[...action.argv, ...(action.input && current ? ["--from", current.caller] : [])].map(quote).join(" ")}` })) };
  });
}

function operationById(db: Database, sprintId: string, id: string): SprintExecutionOperation {
  return rows<SprintExecutionOperation>(db, "sprint_operations", sprintId).find(o => o.id === id)
    ?? fail("NOT_FOUND", "保存した操作がありません");
}
function attemptById(db: Database, sprintId: string, id: string): SprintAttempt {
  return rows<SprintAttempt>(db, "sprint_attempts", sprintId).find(a => a.id === id)
    ?? fail("NOT_FOUND", "保存した試行がありません");
}
function unknown(db: Database, operation: SprintExecutionOperation, code: string, message: string): void {
  operation.state = "unknown"; operation.reason = { code, message }; storeOperation(db, operation);
  const attempt = attemptById(db, operation.sprintId, operation.attemptId);
  attempt.phase = "unknown"; attempt.canStart = false; attempt.reason = operation.reason; storeAttempt(db, attempt); touch(db, operation.sprintId);
}
function invalidateHostObservation(attempt: SprintAttempt, reason: SprintAttempt["reason"]): void {
  attempt.canStart = false;
  if (attempt.hostObservation) attempt.hostObservation = { ...attempt.hostObservation, result: "unavailable", reason };
}
function canSend(ctx: OpCtx, operation: SprintExecutionOperation, current: SprintSession, clock: SprintClock): void {
  const attempt = attemptById(ctx.db, operation.sprintId, operation.attemptId);
  const eligible = getSprintIssueEligibility({ ...ctx, actor: attempt.actor }, operation.sprintId, attempt.itemId, clock);
  if (!eligible.eligible) fail(eligible.reason!.code, eligible.reason!.message);
  if (eligible.planId !== attempt.planId || eligible.planHash !== attempt.planHash
    || current.planId !== attempt.planId || current.planHash !== attempt.planHash) fail("TARGET_CHANGED", "照合した計画が変わっています");
}
// receiptの保存も公開境界にする。遅い旧監督の応答を現在の事実として適用しない。
export function recordSprintExecutionReceipt(ctx: OpCtx, ref: string,
  input: SprintSessionContext & { operationId: string; receipt: SprintExecutionReceipt }, clock: SprintClock = {}): SprintExecutionState {
  return tx(ctx.db, () => {
    const sprintId = getSprint(ctx.db, ref).id, operation = operationById(ctx.db, sprintId, input.operationId);
    const current = session(ctx.db, sprintId);
    if (!current || current.id !== input.sessionId || current.generation !== input.generation || current.actor !== ctx.actor
      || current.state !== "active" || operation.generation !== input.generation) {
      ctx.db.query("INSERT INTO sprint_execution_quarantine VALUES(?,?,?)").run(crypto.randomUUID(), sprintId,
        JSON.stringify({ operationId: operation.id, generation: input.generation, reason: "旧監督の応答は外部照合が必要です", receipt: input.receipt }));
      if (operation.state !== "confirmed") unknown(ctx.db, operation, "QUARANTINED_RESULT", "旧監督の応答を隔離しています。元要求を外部で照合してください");
      touch(ctx.db, sprintId); return getSprintExecutionState(ctx.db, sprintId, clock);
    }
    applyReceipt(ctx.db, operation, input.receipt);
    return getSprintExecutionState(ctx.db, sprintId, clock);
  });
}

export function beginSprintHandover(ctx: OpCtx, ref: string, input: SprintSessionContext & { requestKey: string }): SprintSession {
  sprintObject(input, ["sessionId", "generation", "requestKey"]); sprintText(input.requestKey, "引継ぎ要求キー");
  return tx(ctx.db, () => {
    const sprintId = getSprint(ctx.db, ref).id, current = owned(ctx, sprintId, input, true);
    if (current.handover) {
      if (current.handover.requestKey !== input.requestKey) fail("HANDOVER_PENDING", "先の引継ぎ要求へ合流してください");
      return current;
    }
    current.state = "handover"; current.handover = { requestKey: input.requestKey, caller: null };
    storeSession(ctx.db, current); touch(ctx.db, sprintId); return current;
  });
}
export async function observeSprintSession(ctx: OpCtx, ref: string, input: SprintSessionContext,
  adapter: SprintOrcaAdapter, clock: SprintClock = {}): Promise<SprintExecutionSnapshot> {
  sprintObject(input, ["sessionId", "generation"]);
  const state = await reconcileSprintExecution(ctx, ref, input, adapter, clock);
  let authority: SprintRunAuthority | null = null, inventory: SprintOrcaInventory | null = null;
  const bindings: SprintExecutionSnapshot["bindings"] = [];
  let runtimeConfirmed = false;
  try {
    authority = await adapter.authority(state.session!.runId); checkAuthority(authority, state.session!.runId, clock);
    inventory = adapter.inventory ? await adapter.inventory(state.session!.runId, state.attempts) : null;
    // runtime変更・identity変更からは、同じ永続要求と実行の肯定的な対応を取り直す。
    // 取得不能や空一覧だけでは保存した所有を新runtimeへ移さない。
    if (state.session!.state === "handover" && inventory?.complete) {
      runtimeConfirmed = true;
      for (const operation of state.operations.filter(o => o.state !== "prepared")) {
        const attempt = state.attempts.find(a => a.id === operation.attemptId)!;
        const requestId = operation.requestId ?? state.quarantined.find(q => q.operationId === operation.id && q.receipt.requestId)?.receipt.requestId;
        const response = requestId && adapter.request ? await adapter.request(requestId) : null;
        let receipt = response?.state === "completed" ? response.receipt : null;
        if (receipt && operation.kind === "worker_begin") receipt = bindStartReceipt(operation, receipt);
        if (response?.state === "completed" && (!receipt || receipt.runId !== attempt.runId || response.requestId !== requestId
          || !fresh(response.observedAt, clock) || receipt.requestId !== requestId)) { runtimeConfirmed = false; break; }
        if (operation.kind === "worker_begin") {
          receipt ??= operation.state === "confirmed" ? operation.receipt : null;
          if (!receipt || receipt.taskId !== attempt.taskId || receipt.dispatchId !== attempt.dispatchId) { runtimeConfirmed = false; break; }
          bindings.push({ operationId: operation.id, receipt }); continue;
        }
        if (!receipt) {
          const candidates = inventory.tasks.filter(t => t.runId === attempt.runId && (attempt.taskId ? t.taskId === attempt.taskId
            : operation.kind === "task_create" && t.spec === sprintOrcaTaskSpec(operation) && t.parentTaskId === operation.input.parentTaskId));
          if (candidates.length !== 1) { runtimeConfirmed = false; break; }
          receipt = { runId: attempt.runId, requestId: operation.requestId, taskId: candidates[0]!.taskId, dispatchId: operation.kind === "worker_start" ? attempt.dispatchId : null,
            requested: null, effective: null, identity: null, source: "Orcaの正確な永続Task・Dispatch対応", receivedAt: authority.observedAt };
        }
        if (!receipt.taskId || (attempt.taskId && receipt.taskId !== attempt.taskId)
          || !inventory.tasks.some(t => t.runId === attempt.runId && t.taskId === receipt!.taskId)) { runtimeConfirmed = false; break; }
        if (operation.kind === "worker_start") {
          const workers = inventory.workers.filter(w => w.runId === attempt.runId && w.taskId === receipt.taskId);
          const worker = workers.find(w => (!receipt!.dispatchId || w.dispatchId === receipt!.dispatchId) && (!attempt.dispatchId || w.dispatchId === attempt.dispatchId));
          if (workers.length !== 1 || !worker || worker.liveness === "unverifiable" || !fresh(worker.observedAt, clock)
            || (!worker.identity.runtimeId && !worker.identity.remoteRuntimeEpoch) || !worker.identity.incarnationId) { runtimeConfirmed = false; break; }
          bindings.push({ operationId: operation.id, receipt: { ...receipt, dispatchId: worker.dispatchId, identity: worker.identity, source: worker.source, receivedAt: worker.observedAt } });
        } else bindings.push({ operationId: operation.id, receipt });
      }
      if (!runtimeConfirmed) bindings.length = 0;
    }
  } catch { authority = null; }
  return tx(ctx.db, () => {
    const current = owned(ctx, state.sprintId, input, true);
    if (state.executionVersion !== version(ctx.db, state.sprintId)) fail("RECONCILE_REQUIRED", "観測中に操作または予約が変わりました。元Runを再照合してください");
    const { sprint, plan } = agreed(ctx.db, state.sprintId);
    const changedPlanReason = plan.id !== current.planId || plan.contentHash !== current.planHash
      ? planReconciliationReason(ctx, sprint, plan, state.attempts, clock) : null;
    let reason: SprintExecutionSnapshot["reason"] = null;
    if (!authority || (authority.runtimeId !== current.runtimeId && !runtimeConfirmed) || !inventory?.complete) reason = { code: "AUTHORITY_UNKNOWN", message: "元Runの権限または全実行一覧を確認できません" };
    else if (state.unreconciledOwnership.length) reason = { code: "EXISTING_EXECUTION_UNRECONCILED", message: "通常経路の既存所有が未照合です。所有と実行枠を保持して元の担当を確認してください" };
    else if (changedPlanReason) reason = changedPlanReason;
    else if (!runtimeConfirmed && state.operations.some(o => o.state === "sending" || o.state === "unknown" || o.state === "failed")) reason = { code: "OPERATION_UNRESOLVED", message: "未確定の操作があります。所有と予約を保持して再照合してください" };
    else if (!runtimeConfirmed && state.attempts.some(a => a.phase === "unknown" || (a.taskId !== null && !inventory!.tasks.some(t => t.runId === a.runId && t.taskId === a.taskId))
      || (a.dispatchId !== null && !inventory!.workers.some(w => w.runId === a.runId && w.taskId === a.taskId && w.dispatchId === a.dispatchId && w.liveness !== "unverifiable" && fresh(w.observedAt, clock))))) {
      reason = { code: "EXECUTION_UNKNOWN", message: "保存した担当と元Task・Dispatchの現在の対応を確認できません" };
    }
    const snapshot: SprintExecutionSnapshot = { schemaVersion: 1, id: crypto.randomUUID(), sessionId: current.id, generation: current.generation,
      executionVersion: state.executionVersion, planId: plan.id, planHash: plan.contentHash, authority,
      resolved: reason === null, reason, bindings };
    ctx.db.query("INSERT INTO sprint_execution_snapshots VALUES(?,?,?)").run(snapshot.id, state.sprintId, JSON.stringify(snapshot));
    return snapshot;
  });
}
export function completeSprintHandover(ctx: OpCtx, ref: string,
  input: SprintSessionContext & { snapshotId: string }, clock: SprintClock = {}): SprintExecutionState {
  sprintObject(input, ["sessionId", "generation", "snapshotId"]);
  return tx(ctx.db, () => {
    const sprintId = getSprint(ctx.db, ref).id, current = owned(ctx, sprintId, input, true);
    const row = ctx.db.query("SELECT payload FROM sprint_execution_snapshots WHERE id=? AND sprint_id=?").get(input.snapshotId, sprintId) as { payload: string } | null;
    if (!row) fail("NOT_FOUND", "照合snapshotがありません");
    const snapshot = JSON.parse(row.payload) as SprintExecutionSnapshot;
    if (snapshot.sessionId !== current.id || snapshot.generation !== current.generation
      || snapshot.executionVersion !== version(ctx.db, sprintId)) fail("RECONCILE_REQUIRED", "照合後に監督・操作・予約が変わりました。元Runを再照合してください");
    if (!current.handover) fail("HANDOVER_REQUIRED", "引継ぎintentを保存してから照合してください");
    if (!snapshot.resolved || !snapshot.authority) return getSprintExecutionState(ctx.db, sprintId, clock);
    checkAuthority(snapshot.authority, current.runId, clock);
    const { sprint, plan } = agreed(ctx.db, sprintId);
    if (snapshot.planId !== plan.id || snapshot.planHash !== plan.contentHash) fail("RECONCILE_REQUIRED", "照合後に計画が変わりました");
    const changedPlan = current.planId !== plan.id || current.planHash !== plan.contentHash;
    if (changedPlan) {
      const reason = planReconciliationReason(ctx, sprint, plan, rows<SprintAttempt>(ctx.db, "sprint_attempts", sprintId), clock);
      if (reason) fail(reason.code, reason.message);
      current.planHistory = [...(current.planHistory ?? []), { planId: current.planId, planHash: current.planHash, reconciledAt: timestamp(clock) }];
      current.planId = plan.id; current.planHash = plan.contentHash;
    }
    for (const binding of snapshot.bindings) {
      const operation = operationById(ctx.db, sprintId, binding.operationId);
      applyReceipt(ctx.db, operation, binding.receipt);
      if (operation.kind === "worker_start") {
        const attempt = attemptById(ctx.db, sprintId, operation.attemptId);
        attempt.identity = binding.receipt.identity; attempt.observation = { source: binding.receipt.source, observedAt: binding.receipt.receivedAt };
        if (!attempt.completionResultId) { attempt.phase = "awaiting_confirmation"; attempt.reason = missingObservation; }
        storeAttempt(ctx.db, attempt);
      }
    }
    current.generation++; current.caller = snapshot.authority.caller; current.actor = ctx.actor;
    current.consumerGeneration = snapshot.authority.consumerGeneration; current.observedAt = snapshot.authority.observedAt;
    current.callerIdentity = snapshot.authority.callerIdentity;
    current.callerEvidence = snapshot.authority.callerEvidence;
    current.source = snapshot.authority.source; current.runtimeId = snapshot.authority.runtimeId; current.state = "active"; current.handover = null;
    storeSession(ctx.db, current);
    for (const operation of rows<SprintExecutionOperation>(ctx.db, "sprint_operations", sprintId).filter(o => o.state === "prepared")) {
      operation.generation = current.generation; operation.caller = current.caller; operation.callerIdentity = current.callerIdentity ?? null;
      operation.callerEvidence = current.callerEvidence; operation.consumerGeneration = current.consumerGeneration;
      operation.runtimeId = current.runtimeId; storeOperation(ctx.db, operation);
    }
    for (const attempt of rows<SprintAttempt>(ctx.db, "sprint_attempts", sprintId)) {
      if (changedPlan) {
        attempt.planHistory = [...(attempt.planHistory ?? []), { planId: attempt.planId, planHash: attempt.planHash, reconciledAt: timestamp(clock) }];
        attempt.planId = plan.id; attempt.planHash = plan.contentHash; attempt.reason = missingObservation;
        attempt.settingsRequirement = settingsRequirement(plan, attempt.placement); attempt.canStart = false;
        delete attempt.startConfirmation;
        if (attempt.hostObservation) attempt.hostObservation = { ...attempt.hostObservation, result: "unavailable",
          reason: { code: "PLAN_OBSERVATION_REQUIRED", message: "新合意の版に対応するホスト観測を取り直してください" } };
      }
      attempt.generation = current.generation; storeAttempt(ctx.db, attempt);
    }
    touch(ctx.db, sprintId); return getSprintExecutionState(ctx.db, sprintId, clock);
  });
}
export async function resumeSprintSession(ctx: OpCtx, ref: string, input: SprintSessionContext & { requestKey: string },
  adapter: SprintOrcaAdapter, clock: SprintClock = {}): Promise<{ state: SprintExecutionState; snapshot: SprintExecutionSnapshot }> {
  beginSprintHandover(ctx, ref, input);
  const snapshot = await observeSprintSession(ctx, ref, { sessionId: input.sessionId, generation: input.generation }, adapter, clock);
  const state = completeSprintHandover(ctx, ref, { sessionId: input.sessionId, generation: input.generation, snapshotId: snapshot.id }, clock);
  return { state, snapshot };
}
// 実envelopeの送信元を呼出し側で渡す。正当な同Task/Dispatchは監督交代後も報告できる。
export function getSprintWorkerContext(db: Database, ref: string,
  envelope: { fromHandle: string; runId: string; taskId: string; dispatchId: string }): { attempt: SprintAttempt; generation: number; canStart: false } {
  const state = getSprintExecutionState(db, ref);
  const attempt = state.attempts.find(a => a.runId === envelope.runId && a.taskId === envelope.taskId && a.dispatchId === envelope.dispatchId
    && envelope.fromHandle === `dispatch:${a.dispatchId}`);
  if (!attempt || !state.session) fail("WORKER_MISMATCH", "実際の送信元と現在のTask・Dispatchが一致しません");
  return { attempt, generation: state.session.generation, canStart: false };
}
function applyReceipt(db: Database, operation: SprintExecutionOperation, receipt: SprintExecutionReceipt): void {
  if (operation.kind === "worker_begin") {
    const bound = bindStartReceipt(operation, receipt);
    if (!bound) {
      if (receipt.requestId && !operation.requestId) operation.requestId = receipt.requestId;
      unknown(db, operation, "START_RECEIPT_INCOMPLETE", "元の開始通知requestと実recipientのreceiptを確認できません"); return;
    }
    receipt = bound;
  }
  if (receipt.runId !== operation.runId) {
    if (receipt.requestId && !operation.requestId) operation.requestId = receipt.requestId;
    unknown(db, operation, "RUN_MISMATCH", "応答と保存した元Runの対応を確認できません"); return;
  }
  if (!receipt.source || !Number.isFinite(Date.parse(receipt.receivedAt)) || !receipt.taskId
    || (operation.kind !== "task_create" && (!receipt.dispatchId || receipt.taskId !== operation.input.taskId))
    || (operation.kind === "worker_begin" && receipt.dispatchId !== operation.start?.dispatchId)) {
    if (receipt.requestId && !operation.requestId) operation.requestId = receipt.requestId;
    unknown(db, operation, "RECEIPT_INCOMPLETE", "応答のTask・Dispatch対応を確認できません"); return;
  }
  if (operation.requestId && receipt.requestId && operation.requestId !== receipt.requestId) {
    unknown(db, operation, "REQUEST_MISMATCH", "保存した要求と応答のrequest IDが異なります"); return;
  }
  if (operation.state === "confirmed") {
    if (operation.receipt?.taskId !== receipt.taskId || operation.receipt?.dispatchId !== receipt.dispatchId) fail("IDEMPOTENCY_CONFLICT", "確定した操作と別の実行が届きました");
    return;
  }
  operation.requestId ??= receipt.requestId; operation.receipt = receipt; operation.state = "confirmed"; operation.reason = null;
  storeOperation(db, operation);
  const attempt = attemptById(db, operation.sprintId, operation.attemptId);
  if (operation.kind === "worker_begin") {
    if (!attempt.completionResultId && !attempt.startedReport && attempt.startAuthorization?.id === operation.start?.authorization.id && attempt.hostObservation?.result === "matched") {
      attempt.phase = "start_authorized"; attempt.canStart = true;
      attempt.reason = { code: "START_AUTHORIZED", message: "元の開始通知receiptを確認しました。担当の開始報告を確認してください" };
      storeAttempt(db, attempt);
    }
    touch(db, operation.sprintId); return;
  }
  if (attempt.taskId && attempt.taskId !== receipt.taskId) fail("IDEMPOTENCY_CONFLICT", "主試行のTaskが一致しません");
  if (attempt.dispatchId && receipt.dispatchId && attempt.dispatchId !== receipt.dispatchId) fail("IDEMPOTENCY_CONFLICT", "主試行のDispatchが一致しません");
  attempt.taskId = receipt.taskId; attempt.dispatchId = receipt.dispatchId ?? attempt.dispatchId;
  if (receipt.identity && identityChanged(attempt, receipt.identity)) invalidateHostObservation(attempt, { code: "IDENTITY_CHANGED", message: "receiptの実行identityが変わりました。現在のホストを再照合してください" });
  attempt.identity = receipt.identity ?? attempt.identity;
  if (!attempt.completionResultId && !attempt.startedReport && !attempt.startAuthorization) { attempt.phase = "awaiting_confirmation"; attempt.reason = missingObservation; }
  attempt.observation = { source: receipt.source, observedAt: receipt.receivedAt }; storeAttempt(db, attempt);
  if (operation.kind === "task_create") {
    const prior = rows<SprintExecutionOperation>(db, "sprint_operations", operation.sprintId).find(o => o.attemptId === attempt.id && o.kind === "worker_start");
    if (!prior) storeOperation(db, { ...operation, id: crypto.randomUUID(), kind: "worker_start", state: "prepared",
      requestId: null, receipt: null, inputHash: sprintHash({ taskId: receipt.taskId, placement: operation.input.placement }),
      input: { ...operation.input, taskId: receipt.taskId } });
  }
  touch(db, operation.sprintId);
}
function bindStartReceipt(operation: SprintExecutionOperation, receipt: SprintExecutionReceipt): SprintExecutionReceipt | null {
  if (!operation.start || receipt.notification?.accepted !== true || !receipt.notification.messageId
    || receipt.notification.toHandle !== `dispatch:${operation.start.dispatchId}` || !receipt.requestId
    || (operation.requestId !== null && operation.requestId !== receipt.requestId)) return null;
  // 同じdurable requestと実recipientが揃った場合の操作対応。ホスト設定や欠測identityは補わない。
  return { ...receipt, runId: receipt.runId ?? operation.runId, taskId: receipt.taskId ?? operation.input.taskId,
    dispatchId: receipt.dispatchId ?? operation.start.dispatchId };
}
export async function requestSprintExecution(ctx: OpCtx, ref: string,
  input: SprintSessionContext & { attemptId: string }, adapter: SprintOrcaAdapter, clock: SprintClock = {}): Promise<SprintExecutionState> {
  sprintObject(input, ["sessionId", "generation", "attemptId"]);
  const sprintId = getSprint(ctx.db, ref).id;
  const current = tx(ctx.db, () => owned(ctx, sprintId, input));
  const authority = await adapter.authority(current.runId);
  checkAuthority(authority, current.runId, clock);
  if (authority.caller !== current.caller || authority.runtimeId !== current.runtimeId
    || !sameSprintCaller(current, authority)
    || authority.consumerGeneration !== current.consumerGeneration) fail("AUTHORITY_CHANGED", "監督権限、caller identityまたはruntimeが変わりました。元Runを再照合してください");
  for (let stage = 0; stage < 2; stage++) {
    if (stage > 0) await verifySprintSender(ctx, sprintId, input, adapter, clock);
    const pending = tx(ctx.db, () => {
      const owner = owned(ctx, sprintId, input);
      attemptById(ctx.db, sprintId, input.attemptId);
      const operations = rows<SprintExecutionOperation>(ctx.db, "sprint_operations", sprintId).filter(o => o.attemptId === input.attemptId && o.kind !== "worker_begin");
      const operation = operations.find(o => o.state !== "confirmed");
      if (!operation || operation.state !== "prepared") return null;
      if (operation.generation !== owner.generation || operation.sessionId !== owner.id) fail("STALE_GENERATION", "旧監督の操作です。再照合してください");
      canSend(ctx, operation, owner, clock);
      operation.state = "sending"; storeOperation(ctx.db, operation); touch(ctx.db, sprintId); return operation;
    });
    if (!pending) break;
    let receipt: SprintExecutionReceipt;
    try {
      if (!adapter.send) throw new Error("送信先を確認できません");
      receipt = await adapter.send(pending);
    } catch (error) {
      tx(ctx.db, () => {
        const operation = operationById(ctx.db, sprintId, pending.id);
        if (error instanceof SprintOrcaMutationError && error.requestId && !operation.requestId) operation.requestId = error.requestId;
        if (operation.state !== "confirmed") unknown(ctx.db, operation, "RESPONSE_UNKNOWN", "外部操作の応答を確認できません。元要求を再照合してください");
      });
      break;
    }
    const saved = recordSprintExecutionReceipt(ctx, sprintId, { ...input, operationId: pending.id, receipt }, clock);
    if (saved.session?.generation !== input.generation || saved.session.state !== "active") break;
  }
  return getSprintExecutionState(ctx.db, sprintId, clock);
}

// 操作IDと入力をTaskの正確な写しへ結ぶ。タイトル・cwdの類似だけでは採用しない。
export function sprintOrcaTaskSpec(operation: SprintExecutionOperation): string {
  return `${operation.input.spec}\n\n[nod-operation:${operation.id}]\n担当は実行設定の確認と現在の監督による開始通知を待ち、Issue着手・実装を開始しないでください。`;
}
function identityChanged(a: SprintAttempt, b: NonNullable<SprintAttempt["identity"]>): boolean {
  return a.identity !== null && (["runtimeId", "incarnationId", "terminal", "remoteRuntimeEpoch"] as const)
    .some(key => a.identity![key] !== null && a.identity![key] !== b[key]);
}
export async function reconcileSprintExecution(ctx: OpCtx, ref: string, input: SprintSessionContext,
  adapter: SprintOrcaAdapter, clock: SprintClock = {}): Promise<SprintExecutionState> {
  sprintObject(input, ["sessionId", "generation"]);
  const sprintId = getSprint(ctx.db, ref).id;
  const owner = tx(ctx.db, () => owned(ctx, sprintId, input, true));
  const before = getSprintExecutionState(ctx.db, sprintId, clock);
  let authority: SprintRunAuthority | null = null, inventory: SprintOrcaInventory | null = null;
  const requests = new Map<string, SprintRequestObservation>();
  try {
    authority = await adapter.authority(owner.runId);
    checkAuthority(authority, owner.runId, clock);
    inventory = adapter.inventory ? await adapter.inventory(owner.runId, before.attempts) : null;
    for (const operation of before.operations.filter(o => o.state === "sending" || o.state === "unknown")) {
      const quarantine = before.quarantined.filter(q => q.operationId === operation.id);
      const requestId = operation.requestId ?? quarantine.find(q => q.receipt.requestId)?.receipt.requestId;
      if (requestId && adapter.request) requests.set(operation.id, await adapter.request(requestId));
    }
  } catch {
    return tx(ctx.db, () => {
      owned(ctx, sprintId, input, true);
      for (const operation of rows<SprintExecutionOperation>(ctx.db, "sprint_operations", sprintId).filter(o => o.state !== "prepared")) {
        if (operation.state !== "confirmed") unknown(ctx.db, operation, "CONTACT_UNKNOWN", "元Runまたは実行ホストとの通信を確認できません");
        else {
          const attempt = attemptById(ctx.db, sprintId, operation.attemptId);
          attempt.phase = "unknown"; attempt.reason = { code: "CONTACT_UNKNOWN", message: "実行ホストとの通信を確認できません" };
          invalidateHostObservation(attempt, attempt.reason);
          storeAttempt(ctx.db, attempt); touch(ctx.db, sprintId);
        }
      }
      return getSprintExecutionState(ctx.db, sprintId, clock);
    });
  }
  return tx(ctx.db, () => {
    const current = owned(ctx, sprintId, input, true);
    // 外部待機中の予約・送信・結果保存は照合snapshotを無効にする。
    if (version(ctx.db, sprintId) !== before.executionVersion) fail("RECONCILE_REQUIRED", "照合中に操作または予約が変わりました。同じ元Runを再照合してください");
    const authorityChanged = authority!.runtimeId !== current.runtimeId;
    if (!authorityChanged && current.caller === authority!.caller && current.consumerGeneration === authority!.consumerGeneration) {
      current.observedAt = authority!.observedAt; current.source = authority!.source; storeSession(ctx.db, current);
    }
    for (const operation of rows<SprintExecutionOperation>(ctx.db, "sprint_operations", sprintId)) {
      const attempt = attemptById(ctx.db, sprintId, operation.attemptId);
      if (attempt.completionResultId && operation.state === "confirmed") {
        const worker = inventory?.workers.find(w => w.runId === attempt.runId && w.taskId === attempt.taskId && w.dispatchId === attempt.dispatchId);
        if (worker) attempt.executionLiveness = { verdict: worker.liveness, source: worker.source, observedAt: worker.observedAt };
        if (authorityChanged) invalidateHostObservation(attempt, { code: "RUNTIME_CHANGED", message: "保存した完了結果は保持し、元Runの現在の接続を再照合してください" });
        storeAttempt(ctx.db, attempt); continue;
      }
      const request = requests.get(operation.id);
      let staleWorker = false;
      if (!authorityChanged && request && fresh(request.observedAt, clock) && request.source && request.requestId === (operation.requestId ?? request.receipt?.requestId)) {
        if (request.state === "completed" && request.receipt && request.receipt.requestId === request.requestId) {
          if (request.receipt.identity && identityChanged(attempt, request.receipt.identity)) {
            unknown(ctx.db, operation, "IDENTITY_CHANGED", "保存した実行identityと要求応答が異なります。元Dispatchを確認してください"); continue;
          }
          applyReceipt(ctx.db, operation, request.receipt);
          continue;
        }
      }
      if (inventory?.complete && !authorityChanged) {
        const tasks = inventory.tasks.filter(t => t.runId === current.runId
          && (operation.kind === "task_create" ? t.spec === sprintOrcaTaskSpec(operation) && t.parentTaskId === operation.input.parentTaskId
            : t.taskId === operation.input.taskId));
        const taskId = operation.input.taskId ?? (tasks.length === 1 ? tasks[0]!.taskId : null);
        const workers = inventory.workers.filter(w => w.runId === current.runId && w.taskId === taskId
          && (!attempt.dispatchId || w.dispatchId === attempt.dispatchId));
        if (operation.kind === "task_create" && tasks.length === 1 && operation.state !== "confirmed") {
          applyReceipt(ctx.db, operation, { runId: current.runId, requestId: operation.requestId, taskId: tasks[0]!.taskId, dispatchId: null,
            requested: null, effective: null, identity: null, source: "Orcaの正確なTask対応", receivedAt: timestamp(clock) });
          continue;
        }
        if (operation.kind === "worker_start" && workers.length === 1) {
          const worker = workers[0]!;
          attempt.executionLiveness = { verdict: worker.liveness, source: worker.source, observedAt: worker.observedAt };
          staleWorker = !fresh(worker.observedAt, clock);
          if (identityChanged(attempt, worker.identity)) {
            attempt.phase = "unknown"; attempt.reason = { code: "IDENTITY_CHANGED", message: "runtimeまたは端末incarnationが変わりました。現在の担当を再確認してください" };
            invalidateHostObservation(attempt, attempt.reason);
            storeAttempt(ctx.db, attempt); touch(ctx.db, sprintId); continue;
          }
          if (worker.liveness !== "unverifiable" && fresh(worker.observedAt, clock)) {
            applyReceipt(ctx.db, operation, { runId: worker.runId, requestId: operation.requestId, taskId: worker.taskId, dispatchId: worker.dispatchId,
              requested: operation.receipt?.requested ?? null, effective: operation.receipt?.effective ?? null,
              identity: worker.identity, source: worker.source, receivedAt: worker.observedAt });
            const updated = attemptById(ctx.db, sprintId, attempt.id);
            updated.identity = worker.identity; updated.observation = { source: worker.source, observedAt: worker.observedAt };
            updated.executionLiveness = attempt.executionLiveness;
            if (worker.liveness === "exited") {
              updated.phase = "unknown"; updated.reason = { code: "WORKER_EXITED", message: "元の担当の終了を観測しました。所有と枠を保持して次の扱いを確認してください" };
              invalidateHostObservation(updated, updated.reason);
            } else if (updated.startedReport) {
              updated.phase = "implementing"; updated.reason = { code: "WORKER_STARTED", message: "同じ担当の開始報告を受理済みです" };
            } else if (!updated.startAuthorization) { updated.phase = "awaiting_confirmation"; updated.reason = missingObservation; }
            storeAttempt(ctx.db, updated); touch(ctx.db, sprintId); continue;
          }
        }
      }
      if (operation.state === "prepared" && !authorityChanged) continue;
      const code = authorityChanged ? "RUNTIME_CHANGED" : staleWorker || (request && !fresh(request.observedAt, clock)) ? "OBSERVATION_STALE"
        : request?.state === "pending" ? "REQUEST_PENDING" : request?.state === "absent" ? "REQUEST_ABSENT" : "EXECUTION_UNKNOWN";
      const message = authorityChanged ? "Run homeのruntimeが変わりました。元要求と実行ホストを再照合してください"
        : request?.state === "pending" ? "元の操作はpendingです。非稼働の肯定的証拠とOrcaの回復手順を確認してください"
        : request?.state === "absent" ? "このcallerにreceiptがありません。無実行とは扱わず元Task・Dispatchを確認してください"
        : "元要求とTask・Dispatchの現在の対応を確認できません";
      if (operation.state !== "confirmed") unknown(ctx.db, operation, code, message);
      else if (operation.kind === "worker_start") {
        attempt.phase = "unknown"; attempt.reason = { code, message }; invalidateHostObservation(attempt, attempt.reason);
        storeAttempt(ctx.db, attempt); touch(ctx.db, sprintId);
      }
    }
    return getSprintExecutionState(ctx.db, sprintId, clock);
  });
}

export async function recoverSprintExecution(ctx: OpCtx, ref: string, input: SprintSessionContext & { operationId: string },
  adapter: SprintOrcaAdapter, clock: SprintClock = {}): Promise<SprintExecutionState> {
  sprintObject(input, ["sessionId", "generation", "operationId"]);
  const context = { sessionId: input.sessionId, generation: input.generation };
  const state = await reconcileSprintExecution(ctx, ref, context, adapter, clock);
  const operation = state.operations.find(o => o.id === input.operationId) ?? fail("NOT_FOUND", "保存した操作がありません");
  const owner = tx(ctx.db, () => owned(ctx, state.sprintId, context));
  if (operation.state === "confirmed") return state;
  if (!operation.requestId || !adapter.request || !adapter.send || !adapter.inventory) return state;
  const proof = await adapter.request(operation.requestId);
  const authority = await adapter.authority(owner.runId);
  const inventory = await adapter.inventory(owner.runId, state.attempts);
  checkAuthority(authority, owner.runId, clock);
  const p = operation.input.placement;
  const expected = operation.kind === "worker_begin" ? ["orca", ...sprintOrcaStartNotificationArgs(operation), "--retry-request", operation.requestId, "--json"] : ["orca", "orchestration", operation.kind === "task_create" ? "task-create" : "worker-start",
    ...(operation.kind === "task_create" ? ["--spec", sprintOrcaTaskSpec(operation)] : ["--task", operation.input.taskId!]),
    "--run", operation.runId,
    ...(operation.kind === "task_create" ? operation.input.parentTaskId ? ["--parent", operation.input.parentTaskId] : []
      : ["--worktree", p.worktree, "--agent", p.agent, ...(p.on ? ["--on", p.on] : []), ...(p.model ? ["--model", p.model] : []), ...(p.effort ? ["--effort", p.effort] : [])]),
    "--from", operation.caller, "--retry-request", operation.requestId, "--json"];
  if (proof.state !== "pending" || proof.requestId !== operation.requestId || !fresh(proof.observedAt, clock)
    || !proof.recovery?.originalInactive || !proof.recovery.evidence || JSON.stringify(proof.recovery.argv) !== JSON.stringify(expected)
    || !inventory.complete || authority.caller !== operation.caller || authority.runtimeId !== operation.runtimeId
    || !sameSprintCaller(operation, authority)
    || authority.consumerGeneration !== owner.consumerGeneration) return state;
  let startHost: SprintOrcaHostObservation | null = null;
  if (operation.kind === "worker_begin") {
    const attempt = attemptById(ctx.db, state.sprintId, operation.attemptId);
    try { startHost = adapter.host ? await adapter.host(attempt) : null; } catch { return state; }
    const observed = attempt.hostObservation;
    if (!observed || !operation.start) return state;
    const verdict = judgeObservation(attempt, observed.metadata, observed.selfHost, startHost, clock);
    if (verdict.result !== "matched" || verdict.identityFingerprint !== operation.start.authorization.identityFingerprint
      || verdict.settingsFingerprint !== operation.start.authorization.settingsFingerprint || operation.start.authorization.generation !== owner.generation) return state;
  }
  await verifySprintSender(ctx, state.sprintId, context, adapter, clock);
  const started = tx(ctx.db, () => {
    const current = owned(ctx, state.sprintId, context);
    if (version(ctx.db, state.sprintId) !== state.executionVersion) fail("RECONCILE_REQUIRED", "回復確認中に操作または予約が変わりました");
    const saved = operationById(ctx.db, state.sprintId, operation.id);
    canSend(ctx, saved, current, clock);
    if (saved.requestId !== operation.requestId || !["unknown", "sending"].includes(saved.state)) fail("RECONCILE_REQUIRED", "元要求の状態が変わりました");
    saved.state = "sending"; storeOperation(ctx.db, saved); touch(ctx.db, state.sprintId); return saved;
  });
  try {
    const receipt = await adapter.send(started, started.requestId!);
    return recordSprintExecutionReceipt(ctx, state.sprintId, { ...context, operationId: started.id, receipt }, clock);
  } catch (error) {
    tx(ctx.db, () => unknown(ctx.db, operationById(ctx.db, state.sprintId, started.id), "RESPONSE_UNKNOWN", "同じ既知requestの回復応答を確認できません。元要求を再照合してください"));
    return getSprintExecutionState(ctx.db, state.sprintId, clock);
  }
}
export function sprintOrcaStartNotificationArgs(operation: SprintExecutionOperation): string[] {
  if (operation.kind !== "worker_begin" || !operation.start) fail("INVALID_ARGS", "保存した開始通知操作を指定してください");
  return ["orchestration", "send", "--to", `dispatch:${operation.start.dispatchId}`, "--run", operation.runId, "--from", operation.caller,
    "--type", "status", "--subject", "Sprint実装開始の許可", "--payload", JSON.stringify({ kind: "nod.sprint.start-authorization", schemaVersion: 1,
      runId: operation.runId, taskId: operation.input.taskId, dispatchId: operation.start.dispatchId, attemptId: operation.attemptId,
      authorization: operation.start.authorization })];
}

function settingsRequirement(plan: SprintPlan, placement: PrepareSprintExecutionInput["placement"]): SprintSettingsRequirement {
  const policy = plan.content.constraints.executionSettingsPolicy;
  const value = { mode: policy ? "inherit" as const : "explicit" as const, planId: plan.id, planHash: plan.contentHash, agent: policy?.agent ?? placement.agent,
    model: plan.content.constraints.model ?? null, effort: plan.content.constraints.effort ?? null,
    target: plan.content.constraints.executionTarget ?? null, ...(policy ? { policy } : {}) };
  return { ...value, fingerprint: sprintHash(value) };
}
function observationPayload(value: unknown) {
  const p = sprintObject(value, ["kind", "schemaVersion", "sprintId", "attemptId", "runId", "taskId", "dispatchId", "metadata", "host", "confirmationId", "authorizationId", "observationId"]);
  if (!["nod.sprint.host-observation", "nod.sprint.worker-started"].includes(String(p.kind)) || p.schemaVersion !== 1) fail("OBSERVATION_KIND_REQUIRED", "観測専用statusだけを受理できます");
  for (const key of ["sprintId", "attemptId", "runId", "taskId", "dispatchId"] as const) sprintText(p[key], key);
  const m = sprintObject(p.metadata, ["schemaVersion", "status", "reasons", "threadId", "turnId", "terminal", "cwd", "model", "effort", "provider", "cliVersion", "settingsAppliedAt", "collectedAt", "collectorDigest", "metadataDigest", "source", "association"]);
  if (m.schemaVersion !== 1 || !["observed", "unknown"].includes(String(m.status)) || !Array.isArray(m.reasons)
    || !m.reasons.every(r => typeof r === "string" && r.length < 256)) fail("INVALID_ARGS", "metadataの形式を確認できません");
  for (const [key, value] of Object.entries(m)) if (!["schemaVersion", "reasons"].includes(key) && value !== null
    && (typeof value !== "string" || value.length > 2048)) fail("INVALID_ARGS", "metadataは許可された値だけを指定してください");
  const h = sprintObject(p.host, ["identity", "cwd", "source", "observedAt"]);
  sprintObject(h.identity, ["runtimeId", "incarnationId", "terminal", "remoteRuntimeEpoch"]);
  for (const v of Object.values(h.identity as object)) if (v !== null && (typeof v !== "string" || v.length > 2048)) fail("INVALID_ARGS", "host identityの形式を確認できません");
  for (const key of ["cwd", "source", "observedAt"] as const) sprintText(h[key], key);
  for (const key of ["confirmationId", "authorizationId", "observationId"] as const) if (p[key] !== undefined) sprintText(p[key], key);
  return p as unknown as { kind: string; sprintId: string; attemptId: string; runId: string; taskId: string; dispatchId: string;
    metadata: SprintSelfMetadata; host: SprintHostObservation["selfHost"]; confirmationId?: string; authorizationId?: string; observationId?: string };
}
function judgeObservation(attempt: SprintAttempt, metadata: SprintSelfMetadata, selfHost: SprintHostObservation["selfHost"],
  host: SprintOrcaHostObservation | null, clock: SprintClock): Pick<SprintHostObservation, "result" | "reason" | "identityFingerprint" | "settingsFingerprint"> {
  const unknown = (code: string, message: string) => ({ result: "unavailable" as const, reason: { code, message }, identityFingerprint: null, settingsFingerprint: null });
  const mismatch = (message: string) => ({ result: "mismatched" as const, reason: { code: "HOST_SETTINGS_MISMATCH", message }, identityFingerprint: null, settingsFingerprint: null });
  if (metadata.status !== "observed" || metadata.reasons.length || metadata.cliVersion !== "0.164.0"
    || !metadata.threadId || !metadata.turnId || !metadata.model || !metadata.effort || !metadata.provider
    || !/^[a-f0-9]{64}$/.test(metadata.collectorDigest) || !/^[a-f0-9]{64}$/.test(metadata.metadataDigest ?? "")
    || !metadata.source || !Number.isFinite(Date.parse(metadata.settingsAppliedAt ?? ""))
    || !fresh(metadata.collectedAt, clock) || !fresh(selfHost.observedAt, clock)) return unknown("HOST_METADATA_UNAVAILABLE", "active turnの適用済み設定を取り直してください");
  if (!host || !host.source || !fresh(host.observedAt, clock) || !host.livenessSource || !fresh(host.livenessObservedAt ?? "", clock) || !host.exactWorker || !host.active
    || host.liveness !== "live" || host.runId !== attempt.runId || host.taskId !== attempt.taskId || host.dispatchId !== attempt.dispatchId) {
    return unknown("HOST_IDENTITY_UNAVAILABLE", "保存したactive Dispatchと実行ホストの独立観測を確認できません");
  }
  for (const key of ["runtimeId", "incarnationId", "terminal"] as const) {
    if (!selfHost.identity[key] || !host.identity[key]) return unknown("HOST_IDENTITY_UNAVAILABLE", "実行hostのruntime・端末incarnationの対応が不足しています");
    if (selfHost.identity[key] !== host.identity[key]) return mismatch("自己観測とOrcaの独立host identityが一致しません");
  }
  if (selfHost.identity.remoteRuntimeEpoch !== null && selfHost.identity.remoteRuntimeEpoch !== host.identity.remoteRuntimeEpoch) return mismatch("明示的runtime epochの対応が一致しません");
  if (metadata.terminal !== host.identity.terminal || metadata.cwd !== selfHost.cwd || selfHost.cwd !== host.cwd || host.agent !== attempt.placement.agent) return mismatch("端末・cwd・agentが現在の担当と一致しません");
  const selector = attempt.placement.worktree;
  const requestedPath = selector.startsWith("path:") ? selector.slice(5) : selector.startsWith("/") ? selector
    : selector.startsWith("id:") && selector.includes("::/") ? selector.slice(selector.indexOf("::/") + 2) : null;
  if (!requestedPath) return unknown("PLACEMENT_UNVERIFIABLE", "保存した作業場所selectorと実行cwdの正確な対応を確認してください");
  if (requestedPath !== host.cwd) return mismatch("実行cwdが保存した依頼先の作業場所と一致しません");
  if (attempt.identity && (["runtimeId", "incarnationId", "terminal", "remoteRuntimeEpoch"] as const).some(k => attempt.identity![k] !== null && attempt.identity![k] !== host.identity[k])) return unknown("IDENTITY_CHANGED", "元の担当identityが変わっています。元Dispatchを再照合してください");
  const requirement = attempt.settingsRequirement;
  if (!requirement || ((!requirement.model || !requirement.effort || !requirement.target) && !requirement.policy)) return unknown("SETTINGS_POLICY_REQUIRED", "合意済みの明示設定または継承方針と許可範囲を確認してください");
  const accepts = (actual: string, explicit: string | null, allowed: string[] | undefined) => explicit ? actual === explicit : allowed?.includes(actual) === true;
  if (!accepts(metadata.model, requirement.model, requirement.policy?.allowedModels) || !accepts(metadata.effort, requirement.effort, requirement.policy?.allowedEfforts)
    || !accepts(attempt.placement.on ?? attempt.placement.worktree, requirement.target, requirement.policy?.allowedTargets) || host.agent !== requirement.agent) return mismatch("ホストの適用設定が合意した要求と一致しません");
  return { result: "matched", reason: null,
    identityFingerprint: sprintHash({ dispatch: attempt.dispatchId, identity: host.identity, cwd: host.cwd, thread: metadata.threadId, turn: metadata.turnId, collector: metadata.collectorDigest }),
    settingsFingerprint: sprintHash({ requirement: requirement.fingerprint, model: metadata.model, effort: metadata.effort, provider: metadata.provider }) };
}
function startReportSettingsMatch(db: Database, attempt: SprintAttempt, authorization: NonNullable<SprintAttempt["startAuthorization"]>, observation: SprintHostObservation): boolean {
  if (observation.settingsFingerprint === authorization.settingsFingerprint) return true;
  const operation = rows<SprintExecutionOperation>(db, "sprint_operations", attempt.sprintId).find(o => o.id === authorization.operationId);
  if (operation?.kind !== "worker_begin" || operation.runId !== attempt.runId || operation.input.taskId !== attempt.taskId
    || operation.start?.dispatchId !== attempt.dispatchId || sprintHash(operation.start.authorization) !== sprintHash(authorization)) return false;
  const sprint = getSprint(db, attempt.sprintId);
  const plan = sprint.plans.find(p => p.id === attempt.planId && p.contentHash === attempt.planHash);
  if (!plan) return false;
  const scope = ({ goal: _goal, ...content }: SprintPlan["content"]) => sprintHash(content);
  const currentScope = scope(plan.content), history = attempt.planHistory ?? [];
  // 版番号を無視せず、保存した引継ぎ履歴の全区間でゴール以外が同じ正式合意だけに限る。
  for (let i = 0; i < history.length; i++) {
    const chain = history.slice(i).map(h => sprint.plans.find(p => p.id === h.planId && p.contentHash === h.planHash));
    if (chain.some(p => !p || p.agreedBy !== "me" || !p.agreedAt || p.agreedHash !== p.contentHash || scope(p.content) !== currentScope)) continue;
    const original = chain[0]!;
    const requirement = settingsRequirement(original, operation.input.placement);
    if (sprintHash({ requirement: requirement.fingerprint, model: observation.metadata.model, effort: observation.metadata.effort,
      provider: observation.metadata.provider }) === authorization.settingsFingerprint) return true;
  }
  return false;
}
// message IDだけを受け、実envelopeはadapterのOrca受信箱から取得する。Task3のbatch受理もこの境界へ接続する。
export async function receiveSprintHostObservation(ctx: OpCtx, ref: string, input: { messageId: string },
  adapter: SprintOrcaAdapter, clock: SprintClock = {}): Promise<SprintExecutionState> {
  sprintObject(input, ["messageId"]); sprintText(input.messageId, "message ID");
  const before = getSprintExecutionState(ctx.db, ref, clock);
  if (!before.session || !adapter.status) fail("OBSERVATION_UNAVAILABLE", "元Runの実statusを確認できません");
  const message = await adapter.status(input.messageId, before.session.runId);
  if (!message || message.id !== input.messageId) fail("WORKER_MISMATCH", "実際のOrca status送信元を確認できません");
  try { await recordObservationNotification(ctx, ref, message, adapter, clock); }
  catch (error) {
    if (error instanceof NodError && error.code === "IDEMPOTENCY_CONFLICT") recordNotificationConflict(ctx, ref, message, error, clock);
    throw error;
  }
  return getSprintExecutionState(ctx.db, ref, clock);
}
async function prepareObservationApplication(ctx: OpCtx, ref: string, message: SprintOrcaStatusMessage,
  adapter: SprintOrcaAdapter, clock: SprintClock): Promise<() => SprintExecutionState> {
  const before = getSprintExecutionState(ctx.db, ref, clock);
  if (!before.session || message.type !== "status" || message.runId !== before.session.runId
    || !fresh(message.receivedAt, clock)) fail("WORKER_MISMATCH", "実際のOrca status送信元を確認できません");
  const payload = observationPayload(message.payload);
  const binding = getSprintWorkerContext(ctx.db, ref, { fromHandle: message.fromHandle, runId: message.runId, taskId: payload.taskId, dispatchId: payload.dispatchId });
  const attempt = binding.attempt;
  if (payload.runId !== attempt.runId || payload.sprintId !== before.sprintId || payload.attemptId !== attempt.id) fail("WORKER_MISMATCH", "観測の対象は実送信元の試行と一致しません");
  let host: SprintOrcaHostObservation | null = null;
  try { host = adapter.host ? await adapter.host(attempt) : null; } catch { /* 欠測を保存する。 */ }
  const hash = sprintHash({ from: message.fromHandle, payload });
  return () => tx(ctx.db, () => {
    if (version(ctx.db, before.sprintId) !== before.executionVersion) fail("RECONCILE_REQUIRED", "観測中に所有または試行が変わりました");
    const current = attemptById(ctx.db, before.sprintId, attempt.id);
    // Task1で保存済みの同試行は作り直さず、元の合意済みplanから要求設定だけを対応付ける。
    if (!current.settingsRequirement) {
      const sprint = getSprint(ctx.db, before.sprintId), original = sprint.plans.find(p => p.id === current.planId && p.contentHash === current.planHash
        && p.agreedHash === p.contentHash && p.agreedBy === "me" && p.agreedAt);
      if (original) current.settingsRequirement = settingsRequirement(original, current.placement);
    }
    const prior = current.observationHistory?.find(o => o.messageId === message.id);
    if (prior && prior.inputHash !== hash) fail("IDEMPOTENCY_CONFLICT", "同じ観測messageの内容が異なります");
    if (prior) return getSprintExecutionState(ctx.db, ref, clock);
    const observation: SprintHostObservation = { messageId: message.id, inputHash: hash,
      ...judgeObservation(current, payload.metadata, payload.host, host, clock), metadata: payload.metadata, selfHost: payload.host,
      independent: host, verifiedAt: timestamp(clock), confirmationId: payload.confirmationId ?? null, authorizationId: payload.authorizationId ?? null };
    current.hostObservation = observation; current.observationHistory = [...(current.observationHistory ?? []), observation];
    current.canStart = false;
    current.reason = observation.reason ?? { code: "START_CONFIRMATION_REQUIRED", message: "同じ担当で開始直前の観測を取り直してください" };
    current.phase = observation.result === "matched" ? "awaiting_confirmation" : "unknown";
    if (payload.kind === "nod.sprint.worker-started") {
      const authorization = current.startAuthorization;
      const eligibility = getSprintIssueEligibility({ ...ctx, actor: current.actor }, before.sprintId, current.itemId, clock);
      if (!authorization || payload.authorizationId !== authorization.id || observation.result !== "matched"
        || !eligibility.eligible || eligibility.planId !== current.planId || eligibility.planHash !== current.planHash
        || Date.parse(payload.metadata.collectedAt) < Date.parse(authorization.authorizedAt)
        || observation.identityFingerprint !== authorization.identityFingerprint || !startReportSettingsMatch(ctx.db, current, authorization, observation)) {
        observation.result = "unavailable"; observation.reason = { code: "START_REPORT_MISMATCH", message: "開始許可と現在の担当・設定の対応を確認できません" };
        current.reason = observation.reason; current.phase = "unknown";
      } else {
        current.startedReport = { messageId: message.id, authorizationId: authorization.id, reportedAt: payload.metadata.collectedAt, verifiedAt: timestamp(clock) };
        current.phase = "implementing"; current.reason = { code: "WORKER_STARTED", message: "同じ担当から実装開始の報告を受理しました" };
      }
    }
    storeAttempt(ctx.db, current); touch(ctx.db, before.sprintId); return getSprintExecutionState(ctx.db, ref, clock);
  });
}
export function getSprintNotificationState(db: Database, ref: string, clock: SprintClock = {}): SprintNotificationState {
  const execution = getSprintExecutionState(db, ref, clock);
  return { execution, results: rows(db, "sprint_notification_results", execution.sprintId),
    conflicts: rows(db, "sprint_notification_conflicts", execution.sprintId),
    quarantined: rows(db, "sprint_notification_quarantine", execution.sprintId),
    receptions: rows(db, "sprint_notification_receptions", execution.sprintId),
    deliveries: rows(db, "sprint_notification_deliveries", execution.sprintId) };
}
function notificationConflict(message: string, logicalKey: string, existingResultId: string | null, inputHash: string): never {
  throw new NodError("IDEMPOTENCY_CONFLICT", message, { logicalKey, existingResultId, inputHash });
}
function recordNotificationConflict(ctx: OpCtx, ref: string, message: SprintOrcaStatusMessage, error: NodError,
  clock: SprintClock, fallbackHash?: string): void {
  const sprintId = getSprint(ctx.db, ref).id;
  const details = error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {};
  const hash = typeof details.inputHash === "string" ? details.inputHash : fallbackHash ?? sprintHash({ from: message.fromHandle, payload: message.payload });
  const reason = { code: "IDEMPOTENCY_CONFLICT", message: error.message };
  const conflict = { messageId: message.id, inputHash: hash, reason, savedAt: timestamp(clock),
    logicalKey: typeof details.logicalKey === "string" ? details.logicalKey : null,
    existingResultId: typeof details.existingResultId === "string" ? details.existingResultId : null };
  tx(ctx.db, () => {
    ctx.db.query("INSERT OR IGNORE INTO sprint_notification_conflicts VALUES(?,?,?,?)").run(sprintId, message.id, hash, JSON.stringify(conflict));
    const received: SprintNotificationReception = { messageId: message.id, resultId: null, inputHash: hash, receivedAt: message.receivedAt, reason };
    ctx.db.query("INSERT OR IGNORE INTO sprint_notification_receptions VALUES(?,?,?)").run(message.id, sprintId, JSON.stringify(received));
  });
}
async function recordObservationNotification(ctx: OpCtx, ref: string, message: SprintOrcaStatusMessage,
  adapter: SprintOrcaAdapter, clock: SprintClock, guard: () => void = () => {}): Promise<SprintNotificationResult> {
  const state = getSprintNotificationState(ctx.db, ref, clock), sprintId = state.execution.sprintId;
  const payload = observationPayload(message.payload);
  const binding = getSprintWorkerContext(ctx.db, ref, { fromHandle: message.fromHandle, runId: message.runId, taskId: payload.taskId, dispatchId: payload.dispatchId });
  if (payload.sprintId !== sprintId || payload.attemptId !== binding.attempt.id || payload.runId !== message.runId || message.type !== "status") fail("WORKER_MISMATCH", "実envelopeと観測対象が一致しません");
  const hash = sprintHash({ from: message.fromHandle, payload });
  const logicalKey = JSON.stringify([message.runId, payload.dispatchId, payload.kind, payload.confirmationId ?? null,
    payload.authorizationId ?? null, payload.observationId ?? message.id]);
  const received = state.receptions.find(r => r.messageId === message.id);
  if (received && (received.inputHash !== hash || received.reason)) notificationConflict("同じ受信IDの内容が異なります", logicalKey, received.resultId, hash);
  const prior = state.results.find(r => r.logicalKey === logicalKey);
  if (prior && prior.inputHash !== hash) notificationConflict("同じ業務キーの内容が異なります", logicalKey, prior.id, hash);
  if (!prior && binding.attempt.completionResultId) fail("ATTEMPT_COMPLETED", "完了受理済みの試行です。保存した完了結果と現在の所有者を確認してください");
  const apply = prior ? null : await prepareObservationApplication(ctx, ref, message, adapter, clock);
  return tx(ctx.db, () => {
    guard();
    const latest = getSprintNotificationState(ctx.db, ref, clock);
    let result = latest.results.find(r => r.logicalKey === logicalKey);
    if (result && result.inputHash !== hash) notificationConflict("同じ業務キーの内容が異なります", logicalKey, result.id, hash);
    if (!result) {
      const applied = apply!(), attempt = applied.attempts.find(a => a.id === payload.attemptId)!;
      const observation = attempt.observationHistory?.find(o => o.messageId === message.id)!;
      result = { id: crypto.randomUUID(), logicalKey, inputHash: hash, kind: "observation", attemptId: attempt.id, observation, savedAt: timestamp(clock) };
      ctx.db.query("INSERT INTO sprint_notification_results VALUES(?,?,?,?)").run(result.id, sprintId, logicalKey, JSON.stringify(result));
    }
    const reception: SprintNotificationReception = { messageId: message.id, resultId: result.id, inputHash: hash, receivedAt: message.receivedAt, reason: null };
    ctx.db.query("INSERT OR IGNORE INTO sprint_notification_receptions VALUES(?,?,?)").run(message.id, sprintId, JSON.stringify(reception));
    return result;
  });
}
function storeNotificationDelivery(db: Database, sprintId: string, delivery: SprintNotificationDelivery): void {
  const row = db.query("SELECT payload FROM sprint_notification_deliveries WHERE sprint_id=? AND delivery_id=?").get(sprintId, delivery.deliveryId) as { payload: string } | null;
  const previous = row ? JSON.parse(row.payload) as SprintNotificationDelivery : null;
  if (previous?.ackOperation?.state === "confirmed") {
    // 遅いreceiveの未確定結果で、別receiveが確定した現在Deliveryのackを消さない。
    delivery.ackOperation = previous.ackOperation; delivery.acknowledged = true;
    delivery.rows = previous.rows; delivery.reason = previous.reason;
  } else if (!delivery.ackOperation && previous?.ackOperation) delivery.ackOperation = previous.ackOperation;
  db.query(`INSERT INTO sprint_notification_deliveries VALUES(?,?,?) ON CONFLICT(sprint_id,delivery_id)
    DO UPDATE SET payload=excluded.payload`).run(delivery.deliveryId, sprintId, JSON.stringify(delivery));
}
function storeNotificationReception(db: Database, sprintId: string, reception: SprintNotificationReception): void {
  db.query(`INSERT INTO sprint_notification_receptions VALUES(?,?,?) ON CONFLICT(sprint_id,message_id)
    DO UPDATE SET payload=excluded.payload`).run(reception.messageId, sprintId, JSON.stringify(reception));
}
function recordQuestionNotification(ctx: OpCtx, ref: string, message: SprintOrcaStatusMessage, clock: SprintClock): SprintNotificationResult {
  const p = sprintObject(message.payload, ["taskId", "dispatchId", "question", "options"]);
  const taskId = sprintText(p.taskId, "Task"), dispatchId = sprintText(p.dispatchId, "Dispatch"), text = sprintText(p.question, "質問");
  const { attempt } = getSprintWorkerContext(ctx.db, ref, { fromHandle: message.fromHandle, runId: message.runId, taskId, dispatchId });
  let request: Record<string, unknown> | null = null;
  try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && (typeof parsed.kind === "string" && parsed.kind.startsWith("nod.sprint.") || "requestId" in parsed || "workerRequestId" in parsed)) request = parsed; }
  catch { /* 通常の相談をJSONの解析エラーにはしない。 */ }
  const identified = request !== null || /"kind"\s*:\s*"nod\.sprint\./.test(text);
  const requestId = typeof request?.requestId === "string" ? request.requestId : typeof request?.workerRequestId === "string" ? request.workerRequestId : null;
  const hash = sprintHash({ from: message.fromHandle, type: message.type, payload: request ? { ...p, question: request } : p });
  const logicalKey = JSON.stringify([message.runId, dispatchId, identified ? "request" : "question", requestId ?? message.id]);
  const error = request?.kind === "nod.sprint.host-observation" || request?.kind === "nod.sprint.worker-started"
    ? { code: "OBSERVATION_STATUS_REQUIRED", message: "観測は専用のstatus経路で送信してください" }
    : identified ? request?.kind === "nod.sprint.worker-request" && request.schemaVersion === 1 && requestId
      ? { code: "UNSUPPORTED_OPERATION", message: "この要求はSprintの通知受理で扱える操作ではありません" }
      : { code: "INVALID_REQUEST", message: "識別された要求の形式を確認できません" } : null;
  return tx(ctx.db, () => {
    const state = getSprintNotificationState(ctx.db, ref, clock), sprintId = state.execution.sprintId;
    const prior = state.results.find(r => r.logicalKey === logicalKey);
    if (prior && prior.inputHash !== hash) notificationConflict("同じ質問の内容が異なります", logicalKey, prior.id, hash);
    const reception = state.receptions.find(r => r.messageId === message.id);
    if (reception && reception.inputHash !== hash) notificationConflict("同じ受信IDの内容が異なります", logicalKey, reception.resultId, hash);
    if (prior) {
      if (!reception) storeNotificationReception(ctx.db, sprintId, { messageId: message.id, resultId: prior.id, inputHash: hash, receivedAt: message.receivedAt, reason: null });
      return prior;
    }
    const result: SprintNotificationResult = { id: crypto.randomUUID(), logicalKey, inputHash: hash, kind: error ? "request_rejected" : "question", attemptId: attempt.id,
      question: { text }, response: { body: error ? JSON.stringify({ kind: "nod.sprint.worker-result", schemaVersion: 1, requestId, error }) : null }, savedAt: timestamp(clock) };
    ctx.db.query("INSERT INTO sprint_notification_results VALUES(?,?,?,?)").run(result.id, sprintId, logicalKey, JSON.stringify(result));
    storeNotificationReception(ctx.db, sprintId, { messageId: message.id, resultId: result.id, inputHash: hash, receivedAt: message.receivedAt, reason: null });
    return result;
  });
}
async function replyToSprintNotification(ctx: OpCtx, ref: string, input: SprintNotificationInput, result: SprintNotificationResult,
  message: SprintOrcaStatusMessage, adapter: SprintOrcaAdapter, clock: SprintClock): Promise<SprintNotificationDelivery["reason"]> {
  const sprintId = getSprint(ctx.db, ref).id;
  const answer = input.answers?.find(a => a.messageId === message.id)?.body;
  const body = result.response?.body ?? answer;
  if (answer && result.response?.body && answer !== result.response.body) notificationConflict("保存した返信の内容と異なります", result.logicalKey, result.id, sprintHash({ request: result.inputHash, answer }));
  if (!body) return { code: "REPLY_REQUIRED", message: "保存した質問に回答してから配送をackしてください" };
  if (!adapter.reply) return { code: "REPLY_UNAVAILABLE", message: "元Runへの返信経路を確認してください" };
  const reception = getSprintNotificationState(ctx.db, ref, clock).receptions.find(r => r.messageId === message.id)!;
  if (reception.reply?.state === "confirmed") return null;
  const current = owned(ctx, sprintId, input);
  const previous = reception.reply;
  if (previous?.state === "sending") return { code: "REPLY_PENDING", message: "保存した同じ返信操作を照合してください" };
  const retry = previous?.caller === current.caller && previous.runtimeId === current.runtimeId && sameSprintCaller(previous, current)
    ? previous.requestId ?? undefined : undefined;
  tx(ctx.db, () => {
    owned(ctx, sprintId, input);
    result.response = { body };
    ctx.db.query("UPDATE sprint_notification_results SET payload=? WHERE id=? AND sprint_id=?").run(JSON.stringify(result), result.id, sprintId);
    const target = { runId: message.runId, messageId: message.id };
    reception.reply = { operationId: previous?.operationId ?? crypto.randomUUID(), state: "sending", body, caller: current.caller,
      target, inputHash: sprintHash({ target, body }), sessionId: current.id, runtimeId: current.runtimeId, callerIdentity: current.callerIdentity ?? null, callerEvidence: current.callerEvidence,
      generation: current.generation, requestId: retry ?? null, receipt: null,
      history: [...(previous?.history ?? []), ...(previous ? [{ caller: previous.caller, generation: previous.generation, callerEvidence: previous.callerEvidence,
        requestId: previous.requestId, state: previous.state, receipt: previous.receipt }] : [])] };
    storeNotificationReception(ctx.db, sprintId, reception);
    touch(ctx.db, sprintId);
  });
  try {
    await verifySprintSender(ctx, sprintId, input, adapter, clock);
    const receipt = await adapter.reply(message.runId, message.id, body, retry);
    if (receipt.questionId !== message.id || receipt.status !== "answered" || receipt.body !== body || !receipt.answerMessageId) throw Error();
    try { owned(ctx, sprintId, input); }
    catch (error) {
      reception.reply!.history.push({ caller: current.caller, generation: current.generation, callerEvidence: current.callerEvidence,
        requestId: receipt.requestId, state: "unknown", receipt });
      throw error;
    }
    reception.reply!.state = "confirmed"; reception.reply!.requestId = receipt.requestId; reception.reply!.receipt = receipt;
  } catch (error) {
    reception.reply!.state = "unknown";
    if (error instanceof SprintOrcaMutationError) reception.reply!.requestId ??= error.requestId;
  }
  tx(ctx.db, () => {
    const latest = getSprintNotificationState(ctx.db, ref, clock).receptions.find(r => r.messageId === message.id)!;
    if (latest.reply && (latest.reply.generation !== current.generation || latest.reply.caller !== current.caller
      || latest.reply.state === "confirmed")) {
      latest.reply.history.push(...reception.reply!.history.filter(h => h.receipt !== null));
      storeNotificationReception(ctx.db, sprintId, latest);
      reception.reply!.state = "unknown";
    } else storeNotificationReception(ctx.db, sprintId, reception);
    touch(ctx.db, sprintId);
  });
  return reception.reply!.state === "confirmed" ? null : { code: "REPLY_UNKNOWN", message: "保存した同じ返信の結果を元質問で照合してください" };
}
function recordNoticeNotification(ctx: OpCtx, ref: string, message: SprintOrcaStatusMessage, clock: SprintClock): SprintNotificationResult {
  if (!["status", "heartbeat", "escalation"].includes(message.type)) fail("NOTIFICATION_KIND_UNKNOWN", "通知の種類に対応する処理を確認してください");
  const p = sprintObject(message.payload, ["taskId", "dispatchId", "phase"]);
  const taskId = sprintText(p.taskId, "Task"), dispatchId = sprintText(p.dispatchId, "Dispatch");
  if (p.phase !== undefined) sprintText(p.phase, "工程");
  const { attempt } = getSprintWorkerContext(ctx.db, ref, { fromHandle: message.fromHandle, runId: message.runId, taskId, dispatchId });
  const hash = sprintHash({ from: message.fromHandle, type: message.type, payload: p, body: message.body ?? null });
  const logicalKey = JSON.stringify([message.runId, dispatchId, message.type, message.id]);
  return tx(ctx.db, () => {
    const state = getSprintNotificationState(ctx.db, ref, clock), sprintId = state.execution.sprintId;
    const prior = state.results.find(r => r.logicalKey === logicalKey), reception = state.receptions.find(r => r.messageId === message.id);
    if (prior && prior.inputHash !== hash || reception && reception.inputHash !== hash) notificationConflict("同じ通知の内容が異なります", logicalKey, prior?.id ?? reception?.resultId ?? null, hash);
    const result: SprintNotificationResult = prior ?? { id: crypto.randomUUID(), logicalKey, inputHash: hash, kind: "notice", attemptId: attempt.id,
      savedAt: timestamp(clock), notice: { type: message.type, body: message.body ?? null, phase: p.phase as string ?? null } };
    if (!prior) ctx.db.query("INSERT INTO sprint_notification_results VALUES(?,?,?,?)").run(result.id, sprintId, logicalKey, JSON.stringify(result));
    if (!reception) storeNotificationReception(ctx.db, sprintId, { messageId: message.id, resultId: result.id, inputHash: hash, receivedAt: message.receivedAt, reason: null });
    return result;
  });
}
function recordCompletionNotification(ctx: OpCtx, ref: string, message: SprintOrcaStatusMessage, clock: SprintClock): SprintNotificationResult {
  const p = sprintObject(message.payload, ["taskId", "dispatchId", "outcome", "filesModified", "reportPath"]);
  const taskId = sprintText(p.taskId, "Task"), dispatchId = sprintText(p.dispatchId, "Dispatch");
  if (p.outcome !== "succeeded" && p.outcome !== "failed") fail("INVALID_COMPLETION", "完了通知のoutcomeを確認できません");
  if (p.filesModified !== undefined && (!Array.isArray(p.filesModified) || !p.filesModified.every(v => typeof v === "string"))) fail("INVALID_COMPLETION", "成果への参照形式を確認できません");
  if (p.reportPath !== undefined) sprintText(p.reportPath, "報告への参照");
  const { attempt } = getSprintWorkerContext(ctx.db, ref, { fromHandle: message.fromHandle, runId: message.runId, taskId, dispatchId });
  const hash = sprintHash({ from: message.fromHandle, type: message.type, payload: message.payload, body: message.body ?? null });
  const logicalKey = JSON.stringify([message.runId, dispatchId, "worker_done"]);
  return tx(ctx.db, () => {
    const state = getSprintNotificationState(ctx.db, ref, clock), sprintId = state.execution.sprintId;
    const prior = state.results.find(r => r.logicalKey === logicalKey), reception = state.receptions.find(r => r.messageId === message.id);
    if (prior && prior.inputHash !== hash || reception && reception.inputHash !== hash) notificationConflict("同じDispatchの完了内容が異なります", logicalKey, prior?.id ?? reception?.resultId ?? null, hash);
    const result: SprintNotificationResult = prior ?? { id: crypto.randomUUID(), logicalKey, inputHash: hash, kind: "completion", attemptId: attempt.id,
      savedAt: timestamp(clock), completion: { outcome: p.outcome as "succeeded" | "failed", body: message.body ?? null,
        filesModified: p.filesModified as string[] ?? [], reportPath: p.reportPath as string ?? null,
        state: "unknown", settlement: null, nextOwner: null, ownership: { state: "pending" } } };
    if (!prior) ctx.db.query("INSERT INTO sprint_notification_results VALUES(?,?,?,?)").run(result.id, sprintId, logicalKey, JSON.stringify(result));
    if (!reception) storeNotificationReception(ctx.db, sprintId, { messageId: message.id, resultId: result.id, inputHash: hash, receivedAt: message.receivedAt, reason: null });
    return result;
  });
}
async function reconcileCompletionNotification(ctx: OpCtx, ref: string, input: SprintNotificationInput, result: SprintNotificationResult,
  adapter: SprintOrcaAdapter, clock: SprintClock): Promise<SprintNotificationDelivery["reason"]> {
  const sprintId = getSprint(ctx.db, ref).id, attempt = attemptById(ctx.db, sprintId, result.attemptId);
  let completion = result.completion!;
  const owner = owned(ctx, sprintId, input), decision = input.ownership?.find(d => d.dispatchId === attempt.dispatchId);
  if (completion.state === "settled" && (completion.ownership.state === "released"
    || completion.ownership.state === "assigned" && completion.nextOwner === owner.caller && decision?.action !== "release")) return null;
  let settlement = null;
  try { settlement = adapter.settlement ? await adapter.settlement(attempt) : null; } catch { /* 不明は所有と枠を保持する。 */ }
  const positive = settlement && settlement.runId === attempt.runId && settlement.taskId === attempt.taskId && settlement.dispatchId === attempt.dispatchId
    && settlement.activeDispatchId === attempt.dispatchId && settlement.dispatchStatus === "completed" && settlement.outcome === completion.outcome
    && settlement.taskStatus === completion.outcome && settlement.completedAt && Number.isFinite(Date.parse(settlement.completedAt))
    && settlement.source && fresh(settlement.observedAt, clock);
  const reason = !positive ? { code: "SETTLEMENT_UNKNOWN", message: "現在のTask・Dispatchの肯定的な完了を確認してください。所有と枠は保持しています" }
    : !decision ? { code: "NEXT_OWNER_REQUIRED", message: "完了した担当の次所有者または正規解放を指定してください" }
    : decision.action === "release" ? { code: "RELEASE_REQUIRED", message: "同じDispatchの正規解放を確認してください" } : null;
  tx(ctx.db, () => {
    const current = owned(ctx, sprintId, input);
    result = getSprintNotificationState(ctx.db, ref, clock).results.find(r => r.id === result.id)!;
    completion = result.completion!;
    completion.settlement = settlement; completion.state = positive ? "settled" : "unknown";
    if (!reason) {
      if (completion.nextOwner !== current.caller || completion.ownership.state !== "assigned") completion.ownershipRevision = (completion.ownershipRevision ?? 0) + 1;
      completion.nextOwner = current.caller; completion.ownership = { ...completion.ownership, state: "assigned" };
    }
    ctx.db.query("UPDATE sprint_notification_results SET payload=? WHERE id=? AND sprint_id=?").run(JSON.stringify(result), result.id, sprintId);
    const saved = attemptById(ctx.db, sprintId, attempt.id);
    saved.canStart = false; saved.phase = positive ? "completed" : "unknown";
    if (positive) saved.completionResultId = result.id;
    saved.reason = reason ?? { code: "COMPLETION_RECEIVED", message: "完了通知を受理しました。保存した成果と残件は現在の監督が確認してください" };
    storeAttempt(ctx.db, saved); touch(ctx.db, sprintId);
  });
  if (positive && decision?.action === "release") return releaseCompletionNotification(ctx, ref, input, result, adapter, clock);
  return reason;
}
async function releaseCompletionNotification(ctx: OpCtx, ref: string, input: SprintNotificationInput, result: SprintNotificationResult,
  adapter: SprintOrcaAdapter, clock: SprintClock): Promise<SprintNotificationDelivery["reason"]> {
  const sprintId = getSprint(ctx.db, ref).id, attempt = attemptById(ctx.db, sprintId, result.attemptId);
  if (!adapter.release || !attempt.dispatchId) return { code: "RELEASE_UNKNOWN", message: "同じDispatchの正規解放経路を確認してください" };
  const current = owned(ctx, sprintId, input);
  const claim = tx(ctx.db, (): { operation: SprintNotificationReleaseOperation | null; pending: boolean; retained?: boolean; ownershipRevision: number } => {
    owned(ctx, sprintId, input);
    const latest = getSprintNotificationState(ctx.db, ref, clock).results.find(r => r.id === result.id)!;
    const completion = latest.completion!, previous = completion.releaseOperation, ownership = completion.ownership;
    if (previous?.reconciliation?.state === "completed" && previous.receipt?.state === "retained") {
      return { operation: null, pending: false, retained: true, ownershipRevision: completion.ownershipRevision ?? 0 };
    }
    // caller/世代が同じでも、別receiveの送信中操作は新しく作らない。
    if (previous?.state === "sending") return { operation: null, pending: true, ownershipRevision: completion.ownershipRevision ?? 0 };
    if (previous?.state === "confirmed") return { operation: null, pending: false, ownershipRevision: completion.ownershipRevision ?? 0 };
    const target = { runId: attempt.runId, dispatchId: attempt.dispatchId! }, inputHash = sprintHash(target);
    if (previous && previous.inputHash !== inputHash) notificationConflict("保存した解放対象が異なります", latest.logicalKey, latest.id, inputHash);
    const sameCaller = previous ? previous.caller === current.caller && previous.runtimeId === current.runtimeId
      && sameSprintCaller(previous, current) : ownership.caller === current.caller && !current.callerEvidence && !current.callerIdentity;
    const operation: SprintNotificationReleaseOperation = { operationId: previous?.operationId ?? ownership.operationId ?? crypto.randomUUID(), inputHash, target,
      sessionId: current.id, generation: current.generation, caller: current.caller, callerIdentity: current.callerIdentity ?? null, callerEvidence: current.callerEvidence, runtimeId: current.runtimeId,
      state: "sending", requestId: sameCaller ? previous?.requestId ?? ownership.requestId ?? null : null, receipt: null,
      revision: (previous?.revision ?? 0) + 1, history: [...(previous?.history ?? []), ...(previous ? [{ operationId: previous.operationId,
        revision: previous.revision, generation: previous.generation, caller: previous.caller, callerEvidence: previous.callerEvidence, state: previous.state, requestId: previous.requestId, receipt: previous.receipt }] : [])] };
    completion.releaseOperation = operation;
    completion.ownershipRevision = (completion.ownershipRevision ?? 0) + 1;
    completion.ownership = { ...ownership, state: "sending", operationId: operation.operationId, caller: current.caller, generation: current.generation,
      requestId: operation.requestId, receipt: null, history: [...(ownership.history ?? []), ...(ownership.operationId ? [{ caller: ownership.caller ?? null,
        requestId: ownership.requestId ?? null, receipt: ownership.receipt ?? null }] : [])] };
    ctx.db.query("UPDATE sprint_notification_results SET payload=? WHERE id=? AND sprint_id=?").run(JSON.stringify(latest), latest.id, sprintId);
    touch(ctx.db, sprintId);
    return { operation, pending: false, ownershipRevision: completion.ownershipRevision };
  });
  if (!claim.operation) return claim.retained ? { code: "RELEASE_RETAINED", message: "元requestは端末を保持しました。次所有者を確認してください。所有と枠は保持しています" }
    : claim.pending ? { code: "RELEASE_PENDING", message: "保存した同じ解放操作が送信中です。元操作の結果を確認してください" } : null;
  const sent = claim.operation;
  let receipt = null, requestId = sent.requestId, confirmed = false;
  try {
    await verifySprintSender(ctx, sprintId, input, adapter, clock);
    receipt = await adapter.release(attempt.runId, attempt.dispatchId, sent.requestId ?? undefined);
    requestId = receipt.requestId ?? requestId;
    if (receipt.dispatchId !== attempt.dispatchId || !((receipt.state === "released" && receipt.processAction === "closed_agent_terminal") || receipt.state === "already_released")) throw Error();
    owned(ctx, sprintId, input); confirmed = true;
  } catch (error) { if (error instanceof SprintOrcaMutationError) requestId ??= error.requestId; }
  tx(ctx.db, () => {
    const latest = getSprintNotificationState(ctx.db, ref, clock).results.find(r => r.id === result.id)!;
    const completion = latest.completion!, operation = completion.releaseOperation!;
    if (operation.operationId !== sent.operationId || operation.revision !== sent.revision || operation.state !== "sending") {
      operation.history.push({ operationId: sent.operationId, revision: sent.revision, generation: sent.generation,
        caller: sent.caller, callerEvidence: sent.callerEvidence, state: "unknown", requestId, receipt });
      confirmed = false;
    } else {
      operation.state = confirmed ? "confirmed" : "unknown"; operation.requestId = requestId; operation.receipt = receipt;
      // 応答待ちに選ばれた次所有者を、古いreceiveの結果で置換しない。
      const sameDecision = completion.ownershipRevision === claim.ownershipRevision;
      completion.ownership = { ...completion.ownership, operationId: operation.operationId, requestId, receipt,
        ...(sameDecision ? { state: confirmed ? "released" as const : "unknown" as const } : {}) };
      if (sameDecision && confirmed) completion.nextOwner = null;
    }
    ctx.db.query("UPDATE sprint_notification_results SET payload=? WHERE id=? AND sprint_id=?").run(JSON.stringify(latest), latest.id, sprintId);
    touch(ctx.db, sprintId);
  });
  return confirmed ? null : { code: "RELEASE_UNKNOWN", message: "保存した同じDispatchの解放結果を照合してください。所有と枠は保持しています" };
}
// 通知の外部操作は実行起動operationsとは別に保持する。肯定的な同callerの保存receiptだけを採用し、ここから送信しない。
export async function reconcileSprintNotifications(ctx: OpCtx, ref: string, input: SprintSessionContext,
  adapter: SprintOrcaAdapter, clock: SprintClock = {}): Promise<SprintNotificationState> {
  sprintObject(input, ["sessionId", "generation"]);
  const state = getSprintNotificationState(ctx.db, ref, clock), sprintId = state.execution.sprintId;
  const owner = owned(ctx, sprintId, input, true);
  const pending = state.results.filter(r => r.completion?.releaseOperation?.state === "sending" && r.completion.releaseOperation.requestId);
  const replies = state.receptions.filter(r => r.reply?.state === "sending" && r.reply.requestId);
  const acknowledgments = state.deliveries.filter(d => d.ackOperation?.state === "sending" && d.ackOperation.requestId);
  if (!adapter.notificationRequest || !pending.length && !replies.length && !acknowledgments.length) return state;
  const authority = await adapter.authority(owner.runId); checkAuthority(authority, owner.runId, clock);
  if (authority.caller !== owner.caller || authority.runtimeId !== owner.runtimeId || authority.consumerGeneration !== owner.consumerGeneration
    || !sameSprintCaller(authority, owner)) fail("AUTHORITY_CHANGED", "通知の元requestと現在のcallerを照合してください");
  for (const result of pending) {
    const operation = result.completion!.releaseOperation!;
    if (operation.caller !== owner.caller || operation.runtimeId !== owner.runtimeId || !sameSprintCaller(operation, owner)
      || operation.target.runId !== owner.runId || operation.inputHash !== sprintHash(operation.target)) continue;
    let observation = null;
    try { observation = await adapter.notificationRequest(operation.requestId!); } catch { /* 欠測やpendingを再送許可へ変えない。 */ }
    const receipt = observation?.release;
    if (!observation || observation.state !== "completed" || observation.method !== "orchestration.workerRelease"
      || observation.requestId !== operation.requestId || observation.runtimeId !== operation.runtimeId || !observation.source || !fresh(observation.observedAt, clock)
      || !receipt || receipt.requestId !== operation.requestId || receipt.dispatchId !== operation.target.dispatchId) continue;
    const physicallyReleased = receipt.state === "released" && receipt.processAction === "closed_agent_terminal" || receipt.state === "already_released";
    if (!physicallyReleased && !(receipt.state === "retained" && receipt.processAction === "none")) continue;
    const attempt = attemptById(ctx.db, sprintId, result.attemptId);
    let settlement = null;
    try { settlement = adapter.settlement ? await adapter.settlement(attempt) : null; } catch { /* 現在Taskも別に照合する。 */ }
    const positiveSettlement = settlement && settlement.runId === attempt.runId && settlement.taskId === attempt.taskId && settlement.dispatchId === attempt.dispatchId
      && settlement.activeDispatchId === attempt.dispatchId && settlement.dispatchStatus === "completed" && settlement.taskStatus === result.completion!.outcome
      && settlement.outcome === result.completion!.outcome && settlement.completedAt && Number.isFinite(Date.parse(settlement.completedAt))
      && settlement.source && fresh(settlement.observedAt, clock);
    if (physicallyReleased && !positiveSettlement) continue;
    tx(ctx.db, () => {
      owned(ctx, sprintId, input, true);
      const latest = getSprintNotificationState(ctx.db, ref, clock).results.find(r => r.id === result.id)!;
      const completion = latest.completion!, saved = completion.releaseOperation!;
      if (saved.operationId !== operation.operationId || saved.revision !== operation.revision || saved.inputHash !== operation.inputHash
        || saved.requestId !== operation.requestId || saved.state !== "sending") return;
      saved.state = physicallyReleased ? "confirmed" : "unknown"; saved.receipt = receipt; saved.reconciliation = observation!;
      if (positiveSettlement) { completion.settlement = settlement; completion.state = "settled"; }
      completion.ownership = { ...completion.ownership, operationId: saved.operationId, requestId: saved.requestId, receipt,
        ...(["sending", "unknown"].includes(completion.ownership.state) ? { state: physicallyReleased ? "released" as const : "unknown" as const } : {}) };
      if (completion.ownership.state === "released") completion.nextOwner = null;
      ctx.db.query("UPDATE sprint_notification_results SET payload=? WHERE id=? AND sprint_id=?").run(JSON.stringify(latest), latest.id, sprintId);
      touch(ctx.db, sprintId);
    });
  }
  for (const reception of replies) {
    const operation = reception.reply!;
    if (operation.caller !== owner.caller || operation.runtimeId !== owner.runtimeId || !sameSprintCaller(operation, owner)
      || operation.target.runId !== owner.runId || operation.inputHash !== sprintHash({ target: operation.target, body: operation.body })) continue;
    let observation = null;
    try { observation = await adapter.notificationRequest(operation.requestId!); } catch { /* 未確認は保留する。 */ }
    const receipt = observation?.reply;
    const result = state.results.find(r => r.id === reception.resultId), attempt = result ? attemptById(ctx.db, sprintId, result.attemptId) : null;
    if (!observation || observation.state !== "completed" || observation.method !== "orchestration.reply"
      || observation.requestId !== operation.requestId || observation.runtimeId !== operation.runtimeId || !observation.source || !fresh(observation.observedAt, clock)
      || !receipt || receipt.runId !== operation.target.runId || receipt.dispatchId !== attempt?.dispatchId || receipt.questionId !== operation.target.messageId
      || receipt.requestId !== operation.requestId || receipt.body !== operation.body || receipt.status !== "answered" || !receipt.answerMessageId) continue;
    tx(ctx.db, () => {
      owned(ctx, sprintId, input, true);
      const latest = getSprintNotificationState(ctx.db, ref, clock).receptions.find(r => r.messageId === reception.messageId)!;
      const saved = latest.reply!;
      if (saved.operationId !== operation.operationId || saved.inputHash !== operation.inputHash || saved.requestId !== operation.requestId || saved.state !== "sending") return;
      saved.state = "confirmed"; saved.receipt = receipt; saved.reconciliation = observation!;
      storeNotificationReception(ctx.db, sprintId, latest); touch(ctx.db, sprintId);
    });
  }
  for (const delivery of acknowledgments) {
    const operation = delivery.ackOperation!;
    if (operation.caller !== owner.caller || operation.runtimeId !== owner.runtimeId || !sameSprintCaller(operation, owner)
      || operation.target.runId !== owner.runId || operation.inputHash !== sprintHash(operation.target)) continue;
    let observation = null;
    try { observation = await adapter.notificationRequest(operation.requestId!); } catch { /* 別callerのabsentや欠測でも再送しない。 */ }
    const receipt = observation?.ack;
    if (!observation || observation.state !== "completed" || observation.method !== "orchestration.check"
      || observation.requestId !== operation.requestId || observation.runtimeId !== operation.runtimeId || !observation.source || !fresh(observation.observedAt, clock)
      || !receipt || receipt.runId !== operation.target.runId || receipt.acknowledged !== operation.target.deliveryId || receipt.requestId !== operation.requestId) continue;
    tx(ctx.db, () => {
      owned(ctx, sprintId, input, true);
      const latest = getSprintNotificationState(ctx.db, ref, clock).deliveries.find(d => d.deliveryId === delivery.deliveryId)!;
      const saved = latest.ackOperation!;
      if (saved.operationId !== operation.operationId || saved.inputHash !== operation.inputHash || saved.requestId !== operation.requestId || saved.state !== "sending") return;
      saved.state = "confirmed"; saved.receipt = receipt; saved.reconciliation = observation!;
      latest.acknowledged = true; latest.reason = null;
      storeNotificationDelivery(ctx.db, sprintId, latest); touch(ctx.db, sprintId);
    });
  }
  return getSprintNotificationState(ctx.db, ref, clock);
}
// 業務適用と再送用結果は同じ即時transaction。外部check・host観測・ackはtransactionの外。
export async function receiveSprintNotifications(ctx: OpCtx, ref: string, input: SprintNotificationInput,
  adapter: SprintOrcaAdapter, clock: SprintClock = {}): Promise<SprintNotificationState> {
  sprintObject(input, ["sessionId", "generation", "answers", "ownership"]);
  if (input.answers !== undefined) {
    if (!Array.isArray(input.answers)) fail("INVALID_ARGS", "返信は配列で指定してください");
    for (const answer of input.answers) { sprintObject(answer, ["messageId", "body"]); sprintText(answer.messageId, "質問の受信ID"); sprintText(answer.body, "返信本文"); }
  }
  if (input.ownership !== undefined) {
    if (!Array.isArray(input.ownership)) fail("INVALID_ARGS", "次所有者の指定は配列で指定してください");
    for (const decision of input.ownership) { sprintObject(decision, ["dispatchId", "action"]); sprintText(decision.dispatchId, "Dispatch");
      if (!["coordinator", "release"].includes(decision.action)) fail("INVALID_ARGS", "現在の監督への引継ぎまたは解放を指定してください"); }
  }
  const execution = getSprintExecutionState(ctx.db, ref, clock), sprintId = execution.sprintId;
  const current = owned(ctx, sprintId, input);
  if (!adapter.check || !adapter.acknowledge) fail("NOTIFICATION_UNAVAILABLE", "元Runの配送とackを確認できません");
  const authority = await adapter.authority(current.runId);
  checkAuthority(authority, current.runId, clock);
  if (authority.caller !== current.caller || authority.consumerGeneration !== current.consumerGeneration || authority.runtimeId !== current.runtimeId || !sameSprintCaller(authority, current)) fail("STALE_GENERATION", "元Runの現在の監督を再照合してください");
  await reconcileSprintNotifications(ctx, ref, { sessionId: input.sessionId, generation: input.generation }, adapter, clock);
  let batch = await adapter.check(current.runId);
  const checked = new Set<string>();
  for (;;) {
    if (batch.runId !== current.runId || !Array.isArray(batch.messages) || batch.count !== batch.messages.length) fail("DELIVERY_UNKNOWN", "配送の全行を確認できません");
    if (!batch.deliveryId) {
      if (batch.count) fail("DELIVERY_UNKNOWN", "現在のDelivery IDを確認できません");
      return getSprintNotificationState(ctx.db, ref, clock);
    }
    if (checked.has(batch.deliveryId)) fail("DELIVERY_UNKNOWN", "ack応答が同じ配送を再び返しました。現在のDeliveryを再取得してください");
    checked.add(batch.deliveryId);
    const priorDelivery = getSprintNotificationState(ctx.db, ref, clock).deliveries.find(d => d.deliveryId === batch.deliveryId);
    const delivery: SprintNotificationDelivery = { deliveryId: batch.deliveryId, messageIds: batch.messages.map(m => m?.id).filter(id => typeof id === "string"), acknowledged: false, rows: [], reason: null,
      ...(priorDelivery?.ackOperation ? { ackOperation: priorDelivery.ackOperation } : {}) };
    tx(ctx.db, () => { owned(ctx, sprintId, input); storeNotificationDelivery(ctx.db, sprintId, delivery); });
    for (const message of batch.messages) {
      const row: SprintNotificationDelivery["rows"][number] = { messageId: typeof message?.id === "string" ? message.id : null, resultId: null, reason: null };
      delivery.rows.push(row);
      let receivedHash: string | null = null;
      try {
        if (!message || !message.id || message.runId !== current.runId || !message.fromHandle || !message.type || !message.receivedAt) fail("INVALID_ENVELOPE", "実際の受信envelopeの必須項目を確認できません");
        receivedHash = sprintHash({ from: message.fromHandle, type: message.type, payload: message.payload, ...(message.type === "worker_done" ? { body: message.body ?? null } : {}) });
        if (message.payload && typeof message.payload === "object" && "kind" in message.payload && message.payload.kind === "nod.sprint.start-authorization") {
          fail("COORDINATOR_RESULT_QUARANTINED", "届いた監督の許可は現在状態へ適用しません。元operationと現在の監督世代を再照合してください");
        }
        const result = message.type === "question" ? recordQuestionNotification(ctx, ref, message, clock)
          : message.type === "worker_done" ? recordCompletionNotification(ctx, ref, message, clock)
          : message.type === "status" && message.payload && typeof message.payload === "object" && "kind" in message.payload
            ? await recordObservationNotification(ctx, ref, message, adapter, clock, () => { owned(ctx, sprintId, input); })
            : recordNoticeNotification(ctx, ref, message, clock);
        row.resultId = result.id;
        if (message.type === "question") row.reason = await replyToSprintNotification(ctx, ref, input, result, message, adapter, clock);
        if (message.type === "worker_done") row.reason = await reconcileCompletionNotification(ctx, ref, input, result, adapter, clock);
      } catch (error) {
        row.reason = error instanceof NodError ? { code: error.code, message: error.message } : { code: "NOTIFICATION_UNKNOWN", message: "通知の受理結果を確認できません。元Runを再照合してください" };
        if (row.reason.code === "IDEMPOTENCY_CONFLICT" && receivedHash && row.messageId) {
          recordNotificationConflict(ctx, ref, message, error as NodError, clock, receivedHash);
        } else if (row.messageId && message.fromHandle) {
          const p = message.payload && typeof message.payload === "object" ? message.payload as Record<string, unknown> : {};
          const authorization = p.authorization && typeof p.authorization === "object" ? p.authorization as Record<string, unknown> : {};
          const id = (value: unknown) => typeof value === "string" && value.length <= 2048 ? value : null;
          const generation = p.generation ?? authorization.generation;
          const quarantined = { messageId: row.messageId, fromHandle: message.fromHandle, runId: message.runId, reason: row.reason,
            source: batch.source, observedAt: batch.observedAt, references: { operationId: id(p.operationId ?? authorization.operationId),
              requestId: id(p.requestId), generation: typeof generation === "number" && Number.isSafeInteger(generation) ? generation : null } };
          tx(ctx.db, () => ctx.db.query("INSERT OR IGNORE INTO sprint_notification_quarantine VALUES(?,?,?,?)")
            .run(sprintId, row.messageId!, receivedHash ?? sprintHash({ id: row.messageId, reason: row.reason }), JSON.stringify(quarantined)));
        }
      }
    }
    if (delivery.rows.some(r => r.reason)) {
      delivery.reason = { code: "BATCH_INCOMPLETE", message: "未処理行があるため、この配送はackできません" };
      tx(ctx.db, () => storeNotificationDelivery(ctx.db, sprintId, delivery));
      return getSprintNotificationState(ctx.db, ref, clock);
    }
    const canAck = tx(ctx.db, () => {
      const owner = owned(ctx, sprintId, input);
      const previous = getSprintNotificationState(ctx.db, ref, clock).deliveries.find(d => d.deliveryId === batch.deliveryId)?.ackOperation;
      if (previous?.state === "sending") { delivery.ackOperation = previous; delivery.reason = { code: "ACK_PENDING", message: "保存した現在Deliveryのack操作を照合してください" }; storeNotificationDelivery(ctx.db, sprintId, delivery); return false; }
      if (previous?.state === "confirmed") { delivery.ackOperation = previous; delivery.acknowledged = true; storeNotificationDelivery(ctx.db, sprintId, delivery); return false; }
      const target = { runId: owner.runId, deliveryId: batch.deliveryId! };
      const sameCaller = previous?.caller === owner.caller && previous.runtimeId === owner.runtimeId && sameSprintCaller(previous, owner);
      delivery.ackOperation = { operationId: previous?.operationId ?? crypto.randomUUID(), inputHash: sprintHash(target), target,
        sessionId: owner.id, generation: owner.generation, caller: owner.caller, callerIdentity: owner.callerIdentity ?? null, callerEvidence: owner.callerEvidence, runtimeId: owner.runtimeId,
        state: "sending", requestId: sameCaller ? previous?.requestId ?? null : null, receipt: null,
        history: [...(previous?.history ?? []), ...(previous ? [{ generation: previous.generation, caller: previous.caller, callerEvidence: previous.callerEvidence,
          requestId: previous.requestId, state: previous.state, receipt: previous.receipt }] : [])] };
      storeNotificationDelivery(ctx.db, sprintId, delivery); touch(ctx.db, sprintId); return true;
    });
    if (!canAck) return getSprintNotificationState(ctx.db, ref, clock);
    let next: SprintOrcaDelivery | null = null;
    try {
      await verifySprintSender(ctx, sprintId, input, adapter, clock);
      const ack = await adapter.acknowledge(current.runId, batch.deliveryId, delivery.ackOperation!.requestId ?? undefined);
      delivery.acknowledged = ack.acknowledged === batch.deliveryId;
      next = ack.next;
      delivery.ackOperation!.receipt = { acknowledged: ack.acknowledged, requestId: ack.requestId ?? null, source: ack.source ?? null,
        observedAt: ack.observedAt ?? null, nextDeliveryId: ack.next?.deliveryId ?? null, nextCount: ack.next?.count ?? 0 };
      delivery.ackOperation!.requestId = ack.requestId ?? delivery.ackOperation!.requestId;
    } catch (error) {
      if (error instanceof SprintOrcaMutationError) delivery.ackOperation!.requestId ??= error.requestId;
      if (error instanceof NodError) delivery.reason = { code: error.code, message: error.message };
    }
    delivery.ackOperation!.state = delivery.acknowledged ? "confirmed" : "unknown";
    if (!delivery.acknowledged) delivery.reason ??= { code: "ACK_UNKNOWN", message: "現在の配送のack結果を確認してください" };
    tx(ctx.db, () => storeNotificationDelivery(ctx.db, sprintId, delivery));
    if (delivery.acknowledged && next) { batch = next; continue; }
    return getSprintNotificationState(ctx.db, ref, clock);
  }
}
export function prepareSprintStartConfirmation(ctx: OpCtx, ref: string, input: SprintSessionContext & { attemptId: string }, clock: SprintClock = {}): SprintStartConfirmation {
  sprintObject(input, ["sessionId", "generation", "attemptId"]);
  return tx(ctx.db, () => {
    const sprintId = getSprint(ctx.db, ref).id, current = owned(ctx, sprintId, input), attempt = attemptById(ctx.db, sprintId, input.attemptId);
    if (attempt.completionResultId) fail("ATTEMPT_COMPLETED", "完了受理済みの試行へ開始確認を再発行できません");
    const launch = rows<SprintExecutionOperation>(ctx.db, "sprint_operations", sprintId).find(o => o.attemptId === attempt.id && o.kind === "worker_start");
    if (!launch || launch.state !== "confirmed") fail("RECONCILE_REQUIRED", "元の起動要求を再照合してください");
    canSend(ctx, launch, current, clock);
    const observed = attempt.hostObservation;
    if (observed?.result !== "matched" || !observed.identityFingerprint || !observed.settingsFingerprint || !fresh(observed.metadata.collectedAt, clock)) fail("HOST_OBSERVATION_REQUIRED", "現在の担当のホスト観測を取り直してください");
    if (attempt.startedReport) fail("ALREADY_STARTED", "同じ担当の開始報告を受理済みです");
    if (attempt.startAuthorization) fail("RECONCILE_REQUIRED", "保存した開始通知と開始報告を確認してください");
    const confirmation: SprintStartConfirmation = { id: crypto.randomUUID(), createdAt: timestamp(clock), messageId: observed.messageId,
      identityFingerprint: observed.identityFingerprint, settingsFingerprint: observed.settingsFingerprint };
    attempt.startConfirmation = confirmation; attempt.canStart = false; storeAttempt(ctx.db, attempt); touch(ctx.db, sprintId); return confirmation;
  });
}
export async function requestSprintExecutionStart(ctx: OpCtx, ref: string,
  input: SprintSessionContext & { attemptId: string; messageId: string; confirmationId: string }, adapter: SprintOrcaAdapter, clock: SprintClock = {}): Promise<SprintExecutionState> {
  sprintObject(input, ["sessionId", "generation", "attemptId", "messageId", "confirmationId"]);
  const initial = getSprintExecutionState(ctx.db, ref, clock), owner = owned(ctx, initial.sprintId, input);
  if (initial.attempts.find(a => a.id === input.attemptId)?.completionResultId) fail("ATTEMPT_COMPLETED", "完了受理済みの試行へ新しい開始を許可できません");
  const existing = initial.operations.find(o => o.attemptId === input.attemptId && o.kind === "worker_begin");
  if (existing) return initial; // 応答喪失でも新通知を送らない。元requestへ照合する。
  await receiveSprintHostObservation(ctx, ref, { messageId: input.messageId }, adapter, clock);
  const before = getSprintExecutionState(ctx.db, ref, clock), attempt = attemptById(ctx.db, before.sprintId, input.attemptId);
  const authority = await adapter.authority(owner.runId); checkAuthority(authority, owner.runId, clock);
  let host: SprintOrcaHostObservation | null = null;
  try { host = adapter.host ? await adapter.host(attempt) : null; } catch { /* 直前の欠測は拒否する。 */ }
  const operation = tx(ctx.db, () => {
    const current = owned(ctx, before.sprintId, input), saved = attemptById(ctx.db, before.sprintId, input.attemptId);
    if (before.executionVersion !== version(ctx.db, before.sprintId)) fail("RECONCILE_REQUIRED", "開始直前に予約または観測が変わりました");
    if (authority.caller !== current.caller || authority.runtimeId !== current.runtimeId || authority.consumerGeneration !== current.consumerGeneration
      || !sameSprintCaller(current, authority)) fail("AUTHORITY_CHANGED", "開始直前の監督権限が変わりました");
    const launch = rows<SprintExecutionOperation>(ctx.db, "sprint_operations", before.sprintId).find(o => o.attemptId === saved.id && o.kind === "worker_start")!;
    const observed = saved.hostObservation, confirmation = saved.startConfirmation;
    const notifications = getSprintNotificationState(ctx.db, before.sprintId, clock);
    const reception = notifications.receptions.find(r => r.messageId === input.messageId && !r.reason);
    const canonical = notifications.results.find(r => r.id === reception?.resultId && r.attemptId === saved.id)?.observation?.messageId;
    const denied = (code: string, message: string) => {
      saved.canStart = false; saved.phase = "unknown"; saved.reason = { code, message }; storeAttempt(ctx.db, saved); touch(ctx.db, before.sprintId); return null;
    };
    try { canSend(ctx, launch, current, clock); }
    catch (error) { if (error instanceof NodError) return denied(error.code, error.message); throw error; }
    if (!observed || !confirmation || confirmation.id !== input.confirmationId || observed.confirmationId !== confirmation.id
      || observed.messageId !== canonical || observed.messageId === confirmation.messageId
      || Date.parse(observed.metadata.collectedAt) < Date.parse(confirmation.createdAt)) return denied("FRESH_CONFIRMATION_REQUIRED", "新しい開始確認に対応する自己観測を取り直してください");
    const verdict = judgeObservation(saved, observed.metadata, observed.selfHost, host, clock);
    if (verdict.result !== "matched") return denied(verdict.reason!.code, verdict.reason!.message);
    if (verdict.identityFingerprint !== confirmation.identityFingerprint || verdict.settingsFingerprint !== confirmation.settingsFingerprint) return denied("START_TARGET_CHANGED", "開始確認後にthread・turn・collectorまたは設定が変わりました。開始確認を取り直してください");
    const id = crypto.randomUUID(), authorization = { id: crypto.randomUUID(), confirmationId: confirmation.id, operationId: id, generation: current.generation,
      authorizedAt: timestamp(clock), identityFingerprint: verdict.identityFingerprint!, settingsFingerprint: verdict.settingsFingerprint! };
    const inputValue = { spec: "確認済みの同担当に実装開始を許可", placement: saved.placement, taskId: saved.taskId, parentTaskId: null };
    const value: SprintExecutionOperation = { schemaVersion: 1, id, sprintId: before.sprintId, attemptId: saved.id, kind: "worker_begin",
      requestKey: `begin:${saved.id}:${confirmation.id}`, inputHash: sprintHash({ inputValue, authorization, dispatchId: saved.dispatchId }),
      sessionId: current.id, generation: current.generation, caller: current.caller, callerIdentity: current.callerIdentity ?? null, callerEvidence: current.callerEvidence, runtimeId: current.runtimeId,
      consumerGeneration: current.consumerGeneration, runId: current.runId, state: "sending", requestId: null, receipt: null, input: inputValue, reason: null,
      start: { dispatchId: saved.dispatchId!, authorization, identity: host!.identity } };
    saved.startAuthorization = authorization; saved.canStart = true; saved.phase = "start_authorized";
    saved.reason = { code: "START_AUTHORIZED", message: "開始を許可しました。通知結果と担当の開始報告を確認してください" };
    storeAttempt(ctx.db, saved); storeOperation(ctx.db, value); touch(ctx.db, before.sprintId); return value;
  });
  if (operation) {
    try {
      if (!adapter.send) throw Error();
      const receipt = await adapter.send(operation);
      recordSprintExecutionReceipt(ctx, before.sprintId, { ...input, operationId: operation.id, receipt }, clock);
    } catch (error) {
      tx(ctx.db, () => {
        const saved = operationById(ctx.db, before.sprintId, operation.id);
        if (error instanceof SprintOrcaMutationError && error.requestId) saved.requestId ??= error.requestId;
        unknown(ctx.db, saved, "START_NOTIFICATION_UNKNOWN", "開始通知の結果は不明です。同じ元requestを照合してください");
      });
    }
  }
  return getSprintExecutionState(ctx.db, before.sprintId, clock);
}
