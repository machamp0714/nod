// Bunのe2e control専用。計画は公開HTTPで準備し、実行は公開coreとOrca adapter境界だけを使う。
import * as core from "@nod/core";
import type { Database } from "bun:sqlite";

export async function sprintExecutionFixture(db: Database, ref: string, action: "stale" | "unknown" | "unavailable" | "complete") {
  const now = new Date(Date.now() - (action === "stale" ? 180_000 : 0)), clock = { now }, at = now.toISOString();
  const ctx = { db, actor: "codex" }, sprint = core.getSprint(db, ref);
  const identity = { terminal: "e2e-worker", incarnationId: "e2e-incarnation", runtimeId: "e2e-host", remoteRuntimeEpoch: null };
  const runId = `e2e-run:${sprint.id}`, taskId = `e2e-task:${sprint.id}`, dispatchId = `e2e-dispatch:${sprint.id}`;
  let state = core.getSprintExecutionState(db, ref, clock);
  const host = { runId, taskId, dispatchId, identity, cwd: "/e2e/worker", agent: "codex", active: true, exactWorker: true,
    liveness: action === "unknown" ? "unverifiable" as const : "live" as const, source: "模擬Orcaの独立host観測", observedAt: at, livenessSource: "模擬execution_host", livenessObservedAt: at };
  const adapter: core.SprintOrcaAdapter = {
    authority: async () => ({ runId, caller: "e2e-pm ' $(触らない)", coordinator: "e2e-pm ' $(触らない)", consumerGeneration: 1,
      runtimeId: "e2e-home", source: "模擬Orca Run権限", observedAt: at }),
    send: async op => ({ runId, taskId, dispatchId: op.kind === "task_create" ? null : dispatchId, requestId: `request:${op.id}`,
      requested: { agent: "codex", model: "receipt-model", effort: "medium" }, effective: { agent: "codex", model: "receipt-model", effort: "medium" },
      identity, source: "模擬Orca起動receipt", receivedAt: at }),
    host: async () => host,
    inventory: async () => ({ complete: true, tasks: [{ runId, taskId, spec: "合意した要求を確認する", parentTaskId: null }], workers: [{ runId, taskId, dispatchId, identity,
      liveness: host.liveness, source: host.source, observedAt: at }] }),
    request: async requestId => ({ requestId, state: "completed", receipt: state.operations.find(o => o.requestId === requestId)?.receipt ?? null, source: "模擬Orca元request照合", observedAt: at }),
  };
  const session = state.session ?? await core.beginSprintSession(ctx, ref, { expectedVersion: sprint.version, requestKey: "e2e-session", runId }, adapter, clock);
  const context = { sessionId: session.id, generation: session.generation };
  const attempt = state.attempts[0] ?? core.prepareSprintExecution(ctx, ref, { ...context, requestKey: "e2e-attempt", itemId: sprint.plans.find(p => p.id === sprint.adoptedPlanId)!.content.items[0]!.itemId,
    actor: "codex", spec: "合意した要求を確認する", placement: { worktree: "path:/e2e/worker", on: "fixture-host", agent: "codex", model: "required-model", effort: "high" } }, clock);
  if (!attempt.dispatchId) await core.requestSprintExecution(ctx, ref, { ...context, attemptId: attempt.id }, adapter, clock);
  state = core.getSprintExecutionState(db, ref, clock);
  if (action === "stale" || action === "unavailable") {
    const message: core.SprintOrcaStatusMessage = { id: `e2e-observation:${sprint.id}:${action}`, runId, fromHandle: `dispatch:${dispatchId}`, type: "status", receivedAt: at,
      payload: { kind: "nod.sprint.host-observation", schemaVersion: 1, observationId: `e2e-collection:${action}`, sprintId: sprint.id, attemptId: attempt.id, runId, taskId, dispatchId,
        metadata: { schemaVersion: 1, status: action === "unavailable" ? "unknown" : "observed", reasons: action === "unavailable" ? ["metadata_snapshot_unavailable"] : [], threadId: "e2e-thread", turnId: "e2e-turn", terminal: identity.terminal, cwd: host.cwd,
          model: action === "unavailable" ? null : "host-model", effort: action === "unavailable" ? null : "low", provider: "e2e-provider", cliVersion: "0.164.0", settingsAppliedAt: action === "unavailable" ? null : new Date(now.getTime() - 30_000).toISOString(), collectedAt: at,
          collectorDigest: "a".repeat(64), metadataDigest: "b".repeat(64), source: "模擬provider metadata", association: "thread/context/usage" },
        host: { identity, cwd: host.cwd, source: "模擬自己host観測", observedAt: at } } };
    adapter.status = async () => message;
    await core.receiveSprintHostObservation(ctx, ref, { messageId: message.id }, adapter, clock);
  } else if (action === "unknown") {
    await core.observeSprintSession(ctx, ref, context, adapter, clock);
  } else {
    adapter.check = async () => ({ runId, deliveryId: "e2e-done-delivery", count: 1, source: "模擬Orca check", observedAt: at,
      messages: [{ id: "e2e-done", runId, fromHandle: `dispatch:${dispatchId}`, type: "worker_done", receivedAt: at, body: "成果は別途確認してください",
        payload: { taskId, dispatchId, outcome: "succeeded" } }] });
    adapter.settlement = async () => ({ runId, taskId, dispatchId, activeDispatchId: dispatchId, taskStatus: "succeeded", dispatchStatus: "completed", outcome: "succeeded", completedAt: at, source: "模擬Orca positive settlement", observedAt: at });
    adapter.release = async () => ({ dispatchId, state: "released", processAction: "closed_agent_terminal", requestId: "e2e-release", source: "模擬Orca release", observedAt: at });
    adapter.acknowledge = async (_run, id) => ({ acknowledged: id, next: null });
    await core.receiveSprintNotifications(ctx, ref, { ...context, ownership: [{ dispatchId, action: "release" }] }, adapter, clock);
  }
  return core.getSprintNotificationState(db, ref);
}
