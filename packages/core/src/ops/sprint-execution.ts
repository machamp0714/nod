import type { Database } from "bun:sqlite";
import type { OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { SprintOrcaMutationError } from "../sprint-execution-types";
import { sprintHash, sprintObject, sprintText, sprintVersion } from "../sprint-validation";
import type { SprintClock, SprintDetail, SprintPlan } from "../sprint-types";
import type { PrepareSprintExecutionInput, SprintAttempt, SprintExecutionOperation, SprintExecutionState,
  SprintOrcaAdapter, SprintRunAuthority, SprintSession, SprintSessionContext, SprintSessionInput, SprintExecutionReceipt,
  SprintOrcaInventory, SprintRequestObservation, SprintExecutionSnapshot, SprintExistingOwnership } from "../sprint-execution-types";
import { getSprint } from "./sprints";
import { getSprintIssueEligibility } from "./sprint-eligibility";
import { findIssueRow } from "../issue-query";

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
      if (current.requestKey === input.requestKey && current.inputHash === inputHash && current.caller === authority.caller) return current;
      if (current.requestKey === input.requestKey && current.inputHash !== inputHash) return fail("IDEMPOTENCY_CONFLICT", "同じ要求キーの入力が異なります");
      return fail("EXECUTION_OWNED", "既存の監督が所有しています。session resumeで元Runへ合流してください");
    }
    if (sprint.version !== input.expectedVersion) fail("STALE_REVISION", "Sprintの版が変わっています");
    if (sprint.phase !== "active") fail("SPRINT_NOT_ACTIVE", "Sprintは実行中ではありません");
    const value: SprintSession = { schemaVersion: 1, id: crypto.randomUUID(), sprintId: sprint.id, generation: 1,
      runId: input.runId, actor: ctx.actor, caller: authority.caller, consumerGeneration: authority.consumerGeneration,
      runtimeId: authority.runtimeId, planId: plan.id, planHash: plan.contentHash, state: "active", requestKey: input.requestKey,
      inputHash, observedAt: authority.observedAt, source: authority.source, handover: null, callerIdentity: authority.callerIdentity,
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
      canStart: false, reason: missingObservation, identity: null, observation: null };
    const operation: SprintExecutionOperation = { schemaVersion: 1, id: crypto.randomUUID(), sprintId: sprint.id,
      attemptId: attempt.id, kind: "task_create", requestKey: input.requestKey, inputHash: hash, sessionId: current.id,
      generation: current.generation, caller: current.caller, callerIdentity: current.callerIdentity ?? null,
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
    return { sprintId, session: current, executionVersion: version(db, sprintId), attempts,
      operations: rows<SprintExecutionOperation>(db, "sprint_operations", sprintId), occupied: attempts.filter(a => !a.parentAttemptId).length + unreconciledOwnership.length,
      unreconciledOwnership,
      reserved: attempts.filter(a => !a.parentAttemptId).length, canStart: false,
      stale: current ? !fresh(current.observedAt, clock) : true,
      quarantined: rows(db, "sprint_execution_quarantine", sprintId),
      nextActions: current ? [
        ...(sprint.adoptedPlanId && sprint.adoptedPlanId !== current.planId ? [{ description: "採用中の新合意と元の試行を照合して監督を再開する",
          argv: ["nod", "sprint", "session", "resume", sprintId, "--input", "-"],
          input: { sessionId: current.id, generation: current.generation, requestKey: current.handover?.requestKey ?? `plan:${sprint.adoptedPlanId}` } }] : []),
        ...unreconciledOwnership.map(a => ({ description: "元の担当と保存された通常着手・実行場所を確認する", argv: ["nod", "issue", "show", a.sourceIssueKey, "--json"] })),
        { description: "保存した主試行と元Runの要求・Task・Dispatchを照合する", argv: ["nod", "sprint", "execution", "reconcile", sprintId, "--input", "-"],
        input: { sessionId: current.id, generation: current.generation } }]
        : [{ description: "Sprintの計画と保存した実行対象を確認する", argv: ["nod", "sprint", "show", sprintId] }] };
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
  attempt.phase = "unknown"; attempt.reason = operation.reason; storeAttempt(db, attempt); touch(db, operation.sprintId);
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
        if (response?.state === "completed" && (!receipt || receipt.runId !== attempt.runId || response.requestId !== requestId
          || !fresh(response.observedAt, clock) || receipt.requestId !== requestId)) { runtimeConfirmed = false; break; }
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
        attempt.phase = "awaiting_confirmation"; attempt.reason = missingObservation; storeAttempt(ctx.db, attempt);
      }
    }
    current.generation++; current.caller = snapshot.authority.caller; current.actor = ctx.actor;
    current.consumerGeneration = snapshot.authority.consumerGeneration; current.observedAt = snapshot.authority.observedAt;
    current.callerIdentity = snapshot.authority.callerIdentity;
    current.source = snapshot.authority.source; current.runtimeId = snapshot.authority.runtimeId; current.state = "active"; current.handover = null;
    storeSession(ctx.db, current);
    for (const operation of rows<SprintExecutionOperation>(ctx.db, "sprint_operations", sprintId).filter(o => o.state === "prepared")) {
      operation.generation = current.generation; operation.caller = current.caller; operation.callerIdentity = current.callerIdentity ?? null;
      operation.runtimeId = current.runtimeId; storeOperation(ctx.db, operation);
    }
    for (const attempt of rows<SprintAttempt>(ctx.db, "sprint_attempts", sprintId)) {
      if (changedPlan) {
        attempt.planHistory = [...(attempt.planHistory ?? []), { planId: attempt.planId, planHash: attempt.planHash, reconciledAt: timestamp(clock) }];
        attempt.planId = plan.id; attempt.planHash = plan.contentHash; attempt.reason = missingObservation;
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
  if (receipt.runId !== operation.runId) {
    if (receipt.requestId && !operation.requestId) operation.requestId = receipt.requestId;
    unknown(db, operation, "RUN_MISMATCH", "応答と保存した元Runの対応を確認できません"); return;
  }
  if (!receipt.source || !Number.isFinite(Date.parse(receipt.receivedAt)) || !receipt.taskId
    || (operation.kind === "worker_start" && (!receipt.dispatchId || receipt.taskId !== operation.input.taskId))) {
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
  if (attempt.taskId && attempt.taskId !== receipt.taskId) fail("IDEMPOTENCY_CONFLICT", "主試行のTaskが一致しません");
  if (attempt.dispatchId && receipt.dispatchId && attempt.dispatchId !== receipt.dispatchId) fail("IDEMPOTENCY_CONFLICT", "主試行のDispatchが一致しません");
  attempt.taskId = receipt.taskId; attempt.dispatchId = receipt.dispatchId ?? attempt.dispatchId;
  attempt.identity = receipt.identity ?? attempt.identity; attempt.phase = "awaiting_confirmation"; attempt.reason = missingObservation;
  attempt.observation = { source: receipt.source, observedAt: receipt.receivedAt }; storeAttempt(db, attempt);
  if (operation.kind === "task_create") {
    const prior = rows<SprintExecutionOperation>(db, "sprint_operations", operation.sprintId).find(o => o.attemptId === attempt.id && o.kind === "worker_start");
    if (!prior) storeOperation(db, { ...operation, id: crypto.randomUUID(), kind: "worker_start", state: "prepared",
      requestId: null, receipt: null, inputHash: sprintHash({ taskId: receipt.taskId, placement: operation.input.placement }),
      input: { ...operation.input, taskId: receipt.taskId } });
  }
  touch(db, operation.sprintId);
}
export async function requestSprintExecution(ctx: OpCtx, ref: string,
  input: SprintSessionContext & { attemptId: string }, adapter: SprintOrcaAdapter, clock: SprintClock = {}): Promise<SprintExecutionState> {
  sprintObject(input, ["sessionId", "generation", "attemptId"]);
  const sprintId = getSprint(ctx.db, ref).id;
  const current = tx(ctx.db, () => owned(ctx, sprintId, input));
  const authority = await adapter.authority(current.runId);
  checkAuthority(authority, current.runId, clock);
  if (authority.caller !== current.caller || authority.runtimeId !== current.runtimeId
    || (current.callerIdentity && authority.callerIdentity !== current.callerIdentity)
    || authority.consumerGeneration !== current.consumerGeneration) fail("AUTHORITY_CHANGED", "監督権限、caller identityまたはruntimeが変わりました。元Runを再照合してください");
  for (let stage = 0; stage < 2; stage++) {
    const pending = tx(ctx.db, () => {
      const owner = owned(ctx, sprintId, input);
      attemptById(ctx.db, sprintId, input.attemptId);
      const operations = rows<SprintExecutionOperation>(ctx.db, "sprint_operations", sprintId).filter(o => o.attemptId === input.attemptId);
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
          staleWorker = !fresh(worker.observedAt, clock);
          if (identityChanged(attempt, worker.identity)) {
            attempt.phase = "unknown"; attempt.reason = { code: "IDENTITY_CHANGED", message: "runtimeまたは端末incarnationが変わりました。現在の担当を再確認してください" };
            storeAttempt(ctx.db, attempt); touch(ctx.db, sprintId); continue;
          }
          if (worker.liveness !== "unverifiable" && fresh(worker.observedAt, clock)) {
            applyReceipt(ctx.db, operation, { runId: worker.runId, requestId: operation.requestId, taskId: worker.taskId, dispatchId: worker.dispatchId,
              requested: operation.receipt?.requested ?? null, effective: operation.receipt?.effective ?? null,
              identity: worker.identity, source: worker.source, receivedAt: worker.observedAt });
            const updated = attemptById(ctx.db, sprintId, attempt.id);
            updated.identity = worker.identity; updated.observation = { source: worker.source, observedAt: worker.observedAt };
            updated.phase = "awaiting_confirmation"; updated.reason = missingObservation;
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
        attempt.phase = "unknown"; attempt.reason = { code, message }; storeAttempt(ctx.db, attempt); touch(ctx.db, sprintId);
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
  const expected = ["orca", "orchestration", operation.kind === "task_create" ? "task-create" : "worker-start",
    ...(operation.kind === "task_create" ? ["--spec", sprintOrcaTaskSpec(operation)] : ["--task", operation.input.taskId!]),
    "--run", operation.runId,
    ...(operation.kind === "task_create" ? operation.input.parentTaskId ? ["--parent", operation.input.parentTaskId] : []
      : ["--worktree", p.worktree, "--agent", p.agent, ...(p.on ? ["--on", p.on] : []), ...(p.model ? ["--model", p.model] : []), ...(p.effort ? ["--effort", p.effort] : [])]),
    "--from", operation.caller, "--retry-request", operation.requestId, "--json"];
  if (proof.state !== "pending" || proof.requestId !== operation.requestId || !fresh(proof.observedAt, clock)
    || !proof.recovery?.originalInactive || !proof.recovery.evidence || JSON.stringify(proof.recovery.argv) !== JSON.stringify(expected)
    || !inventory.complete || authority.caller !== operation.caller || authority.runtimeId !== operation.runtimeId
    || (operation.callerIdentity && authority.callerIdentity !== operation.callerIdentity)
    || authority.consumerGeneration !== owner.consumerGeneration) return state;
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
