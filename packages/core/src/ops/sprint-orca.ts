import { NodError } from "../errors";
import { isDeepStrictEqual } from "node:util";
import { SprintOrcaMutationError, sameSprintCaller, type SprintCallerEvidence, type SprintExecutionIdentity, type SprintExecutionOperation,
  type SprintExecutionReceipt, type SprintOrcaAdapter, type SprintOrcaInventory, type SprintRequestObservation } from "../sprint-execution-types";
import type { SprintClock } from "../sprint-types";
import { ORCA_CREATE_TIMEOUT_MS, ORCA_TIMEOUT_MS, type OrcaRunner } from "./orca";
import { sprintOrcaTaskSpec, sprintOrcaStartNotificationArgs } from "./sprint-execution";
import { collectSprintSelfMetadata, type SprintSelfMetadata, type SprintSelfMetadataSource } from "../sprint-self-metadata";
import type { SprintHostObservation } from "../sprint-observation-types";
import type { SprintOrcaDelivery } from "../sprint-notification-types";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {}; }
function string(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
// 公開sendのdurable enqueueだけを判定する。受信側の適用や実装開始の証拠ではない。
interface SprintOrcaSendExpectation { dispatchId: string; destination: "run_home" | "worker"; runId: string; from: string; payload: ObjectValue }
export function parseSprintOrcaSendReceipt(raw: unknown, expected: SprintOrcaSendExpectation) {
  const value = object(raw), relay = object(value.relay), message = object(value.message);
  let payload: ObjectValue = {};
  if (typeof message.payload === "string") { try { payload = object(JSON.parse(message.payload)); } catch { /* 不明のまま保持する。 */ } }
  const allowed = (value.accepted === undefined || value.accepted === true)
    && !["rejected", "suppressed"].includes(String(object(value.lifecycle).action))
    && (value.runId === undefined || value.runId === expected.runId)
    && (value.taskId === undefined || value.taskId === expected.payload.taskId)
    && (value.dispatchId === undefined || value.dispatchId === expected.dispatchId);
  const relayed = value.relay !== undefined && value.message === undefined
    && relay.accepted === true && !!string(relay.messageId)
    && relay.dispatchId === expected.dispatchId && relay.destination === expected.destination;
  const direct = value.message !== undefined && value.relay === undefined && !!string(message.id) && !!string(message.from_handle)
    && message.run_id === expected.runId && message.from_handle === expected.from && message.type === "status"
    && message.to_handle === (expected.destination === "worker" ? `dispatch:${expected.dispatchId}` : `run:${expected.runId}`)
    && isDeepStrictEqual(payload, expected.payload);
  return {
    accepted: allowed && (relayed || direct),
    messageId: string(relay.messageId ?? message.id), requestId: string(object(value.mutation).requestId),
  };
}
function invalid(reason = "Orcaの応答形式または対応を確認できません"): never { throw new NodError("ORCA_OBSERVATION_UNKNOWN", reason); }
function identity(value: unknown): SprintExecutionIdentity {
  const raw = object(value);
  return { runtimeId: string(raw.runtimeId), incarnationId: string(raw.incarnationId ?? raw.terminalIncarnationId),
    terminal: string(raw.terminal ?? raw.agentTerminalHandle), remoteRuntimeEpoch: string(raw.remoteRuntimeEpoch) };
}
function settings(value: unknown): SprintExecutionReceipt["requested"] {
  if (value === null || value === undefined) return null;
  const raw = object(value);
  return { agent: string(raw.agent), model: string(raw.model), effort: string(raw.effort) };
}
export async function collectSprintSelfHost(run: OrcaRunner | null, metadata: SprintSelfMetadata, clock: SprintClock = {}): Promise<SprintHostObservation["selfHost"]> {
  const missing = { identity: { terminal: metadata.terminal, incarnationId: null, runtimeId: null, remoteRuntimeEpoch: null }, cwd: metadata.cwd ?? "",
    source: "自己hostのOrca status・terminal showは取得不能", observedAt: (clock.now ?? new Date()).toISOString() };
  if (!run || !metadata.terminal) return missing;
  try {
    const read = async (args: string[]) => {
      const response = await run([...args, "--json"], { timeoutMs: ORCA_TIMEOUT_MS, maxStdoutBytes: 1024 * 1024 });
      if (response.kind !== "exited" || response.exitCode !== 0) return invalid();
      const value = object(JSON.parse(response.stdout)); if (value.ok !== true) return invalid(); return value;
    };
    const status = await read(["status"]), shown = await read(["terminal", "show", "--terminal", metadata.terminal]);
    const runtime = object(object(status.result).runtime), terminal = object(object(shown.result).terminal);
    if (!string(runtime.runtimeId) || object(status._meta).runtimeId !== runtime.runtimeId || object(shown._meta).runtimeId !== runtime.runtimeId
      || runtime.reachable !== true || terminal.handle !== metadata.terminal || terminal.worktreePath !== metadata.cwd
      || terminal.agentIdentity !== "codex" || terminal.connected !== true || !string(terminal.incarnationId)) return missing;
    return { identity: { terminal: metadata.terminal, incarnationId: string(terminal.incarnationId), runtimeId: string(runtime.runtimeId),
      remoteRuntimeEpoch: string(object(shown.result).remoteRuntimeEpoch) }, cwd: metadata.cwd!, source: "自己hostのOrca status・terminal show（許可metadataのみ）", observedAt: (clock.now ?? new Date()).toISOString() };
  } catch { return missing; }
}
// shellを挟まずargvで呼ぶ。資格情報を含み得るraw応答は保存せず、許可したreceipt項目だけを返す。
export function createSprintOrcaAdapter(run: OrcaRunner | null,
  options: { from?: string; environment?: string; clock?: SprintClock; selfMetadataSource?: SprintSelfMetadataSource } = {}): SprintOrcaAdapter {
  const at = () => (options.clock?.now ?? new Date()).toISOString();
  const from = options.from ?? process.env.ORCA_TERMINAL_HANDLE;
  const sender = from ? ["--from", from] : [];
  async function call(args: string[], mutation = false, target: string | null | undefined = options.environment): Promise<{ result: ObjectValue; runtimeId: string | null }> {
    if (!run) throw new NodError("ORCA_DISABLED", "Orcaとの接続が無効です。元Runの実行先を確認してください");
    const response = await run([...args, ...(target ? ["--environment", target] : []), "--json"], {
      timeoutMs: mutation ? ORCA_CREATE_TIMEOUT_MS : ORCA_TIMEOUT_MS, maxStdoutBytes: 1024 * 1024,
    });
    if (response.kind !== "exited") {
      if (mutation) throw new SprintOrcaMutationError(null);
      return invalid();
    }
    let envelope: ObjectValue;
    try { envelope = object(JSON.parse(response.stdout)); } catch { if (mutation) throw new SprintOrcaMutationError(null); return invalid(); }
    const result = object(envelope.result);
    if (envelope.ok !== true || response.exitCode !== 0) {
      if (mutation) {
        const data = object(object(envelope.error).data);
        throw new SprintOrcaMutationError(string(data.orchestrationRequestId ?? object(data.recovery).orchestrationRequestId ?? object(result.mutation).requestId));
      }
      return invalid();
    }
    return { result, runtimeId: string(object(envelope._meta).runtimeId) };
  }
  async function authority(runId: string) {
    if (!from) return invalid("自己callerが未取得です");
    const observe = async () => {
      const observations: Extract<SprintCallerEvidence, { kind: "native_terminal" }>["observations"] = [];
      const read = async (args: string[], kind: typeof observations[number]["kind"]) => {
        const value = await call(args);
        if (!value.runtimeId) return invalid("観測元runtimeが未取得です");
        observations.push({ kind, source: `Orca ${args.slice(0, 2).join(" ")}`, observedAt: at(), runtimeId: value.runtimeId });
        return value;
      };
      const status = await read(["status"], "status"), runtime = object(status.result.runtime);
      const runtimeId = string(runtime.runtimeId);
      if (!runtimeId || status.runtimeId !== runtimeId || runtime.state !== "ready" || runtime.reachable !== true
        || runtime.connectionState !== "connected") return invalid("自己runtimeがready・接続中ではありません");
      let callerIdentity: string | undefined, callerEvidence: SprintCallerEvidence;
      if (Object.hasOwn(status.result, "caller")) {
        const caller = object(status.result.caller);
        callerIdentity = string(caller.orcaSessionId) ?? undefined;
        if (!callerIdentity?.startsWith("orca_session_id:") || !callerIdentity.slice("orca_session_id:".length)
          || caller.live !== true || caller.refusal !== undefined) return invalid("structured callerの正式session address・live観測が拒否または不完全です");
        // 公開fieldの値はhostがlineage解決したaddress。injected raw UIDと同一視しない。
        callerEvidence = { kind: "orca_session", orcaSessionId: callerIdentity, source: "Orca statusのhost解決済みsession address", observedAt: at() };
      } else {
        if (process.env.ORCA_AGENT_SESSION_ID?.trim()) return invalid("structured callerの観測が欠測しています");
        const self = process.env.ORCA_TERMINAL_HANDLE;
        if (!self || self !== from) return invalid("指定fromが継承された自己terminalと一致しません");
        const metadata = collectSprintSelfMetadata(options.selfMetadataSource, options.clock);
        if (metadata.status !== "observed" || metadata.terminal !== self || metadata.cwd !== process.cwd()
          || metadata.threadId !== (options.selfMetadataSource?.threadId ?? process.env.CODEX_THREAD_ID)) {
          return invalid(`自己metadataを照合できません: ${metadata.reasons.join(",") || "identity_mismatch"}`);
        }
        const shown = await read(["terminal", "show", "--terminal", self], "terminal"), terminal = object(shown.result.terminal);
        if (shown.runtimeId !== runtimeId || terminal.handle !== self || terminal.worktreePath !== metadata.cwd
          || terminal.connected !== true || terminal.agentIdentity !== "codex" || !string(terminal.incarnationId)) {
          return invalid("自己terminalのincarnation・接続・cwd・agentを照合できません");
        }
        callerEvidence = { kind: "native_terminal", identity: { terminal: self, incarnationId: string(terminal.incarnationId), runtimeId,
          remoteRuntimeEpoch: string(shown.result.remoteRuntimeEpoch) }, metadata, observations,
          source: "自己collectorと独立したOrca status・terminal show・default Run binding", observedAt: at() };
      }
      // 明示--fromはCLIの本人resolverを迂回するため、binding取得へ渡さない。
      const bound = await read(["orchestration", "run-current"], "run_current");
      const shown = await read(["orchestration", "run-show", "--id", runId], "run_show");
      const current = object(bound.result.run), target = object(shown.result.run);
      if (bound.runtimeId !== runtimeId || shown.runtimeId !== runtimeId || current.id !== runId || target.id !== runId
        || current.coordinator_handle !== from || target.coordinator_handle !== from
        || current.consumer_generation !== target.consumer_generation || !Number.isSafeInteger(target.consumer_generation)
        || (target.consumer_generation as number) < 0) return invalid("自己Run bindingと現在consumerの対応が変化または欠測しています");
      return { runId, caller: from, ...(callerIdentity ? { callerIdentity } : {}), callerEvidence, coordinator: from,
        consumerGeneration: target.consumer_generation as number, runtimeId, source: "Orca本人status・default run-current・run-showの前後照合", observedAt: at() };
    };
    const first = await observe(), last = await observe();
    if (!sameSprintCaller(first, last) || first.runtimeId !== last.runtimeId || first.consumerGeneration !== last.consumerGeneration) {
      return invalid("権限取得中に本人・runtime・incarnationまたはconsumerが変わりました");
    }
    if (first.callerEvidence.kind === "native_terminal" && last.callerEvidence.kind === "native_terminal") {
      last.callerEvidence.observations = [...first.callerEvidence.observations, ...last.callerEvidence.observations];
    }
    return last;
  }
  function receipt(raw: unknown, knownRequest: string | null = null, expected?: SprintOrcaSendExpectation): SprintExecutionReceipt {
    const value = object(raw), task = object(value.task), dispatch = object(value.dispatch), worker = object(value.worker);
    const launch = object(value.launch ?? object(value.startOptions).launch);
    const relay = object(value.relay), message = object(value.message);
    let payload: ObjectValue = {};
    if (typeof message.payload === "string") { try { payload = object(JSON.parse(message.payload)); } catch { /* unknown */ } }
    const recoveredStart = payload.kind === "nod.sprint.start-authorization" && payload.schemaVersion === 1
      && string(payload.runId) && string(payload.taskId) && string(payload.dispatchId) && string(payload.attemptId)
      && string(object(payload.authorization).id);
    const sent = parseSprintOrcaSendReceipt(value, expected ?? { dispatchId: string(relay.dispatchId ?? payload.dispatchId) ?? "", destination: "worker",
      runId: string(value.runId ?? payload.runId) ?? "", from: recoveredStart ? string(message.from_handle) ?? "" : "", payload: recoveredStart ? payload : {} });
    const messageId = sent.messageId;
    const toHandle = string(message.to_handle) ?? (relay.destination === "worker" && string(relay.dispatchId) ? `dispatch:${relay.dispatchId}` : null);
    return { runId: string(value.runId ?? task.run_id ?? dispatch.runId ?? message.run_id), requestId: string(object(value.mutation).requestId ?? value.requestId) ?? knownRequest,
      taskId: string(value.taskId ?? task.id ?? dispatch.task_id ?? worker.taskId ?? payload.taskId),
      dispatchId: string(value.dispatchId ?? dispatch.id ?? worker.dispatchId ?? relay.dispatchId ?? payload.dispatchId),
      requested: settings(launch.requested), effective: settings(launch.effective),
      identity: value.identity ? identity(value.identity) : null,
      source: "Orca起動・操作receipt", receivedAt: at(),
      ...(sent.accepted && messageId && toHandle ? { notification: { messageId, toHandle, accepted: true as const } } : {}) };
  }
  async function allPages(verb: "task-list" | "worker-list", runId: string): Promise<{ values: ObjectValue[]; complete: boolean }> {
    let cursor: string | null = null;
    const seen = new Set<string>(), values: ObjectValue[] = [];
    for (;;) {
      const { result } = await call(["orchestration", verb, "--run", runId,
        ...(verb === "worker-list" ? ["--include-remote"] : []), ...(cursor ? ["--cursor", cursor] : [])]);
      const list = result[verb === "task-list" ? "tasks" : "workers"];
      if (!Array.isArray(list)) return { values, complete: false };
      values.push(...list.map(object));
      const page = object(result.page), hasMore = page.hasMore ?? (string(result.nextCursor) !== null);
      if (hasMore === false) {
        const total = typeof page.total === "number" ? page.total : cursor === null && typeof result.count === "number" ? result.count : null;
        return { values, complete: total === null || Number.isSafeInteger(total) && total === values.length };
      }
      cursor = string(page.nextCursor ?? result.nextCursor);
      if (!cursor || seen.has(cursor)) return { values, complete: false };
      seen.add(cursor);
    }
  }
  function message(raw: unknown) {
    const value = object(raw);
    let payload = value.payload;
    if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch { /* 不正な行を捨てずcoreの診断へ渡す。 */ } }
    return { id: string(value.id) ?? "", runId: string(value.run_id) ?? "", fromHandle: string(value.from_handle) ?? "",
      type: string(value.type) ?? "", receivedAt: at(), payload, body: string(value.body), createdAt: string(value.created_at) };
  }
  function delivery(result: ObjectValue, runId: string): SprintOrcaDelivery {
    if (result.runId !== runId || !Array.isArray(result.messages) || !Number.isSafeInteger(result.count)) return invalid();
    return { runId, deliveryId: string(result.deliveryId), messages: result.messages.map(message), count: result.count as number,
      source: "Orca orchestration checkの全行", observedAt: at() };
  }
  return {
    async notificationRequest(requestId) {
      const { result, runtimeId } = await call(["orchestration", "request-show", "--request", requestId]);
      const state = result.state, method = string(result.method), saved = object(result.receipt);
      if (result.requestId !== requestId || !["absent", "pending", "completed"].includes(String(state))) return invalid();
      const base = { requestId, state: state as "absent" | "pending" | "completed", method, runtimeId,
        source: "Orca request-show（現在のcallerで保存requestを読取）", observedAt: at() };
      if (state !== "completed") return base;
      if (method === "orchestration.check") {
        const runId = string(saved.runId), acknowledged = string(saved.acknowledged), receiptRequest = string(object(saved.mutation).requestId);
        if (!runId || !acknowledged || receiptRequest !== requestId || !Array.isArray(saved.messages) || !Number.isSafeInteger(saved.count)
          || saved.count !== saved.messages.length || saved.count !== 0 && !string(saved.deliveryId)) return base;
        return { ...base, ack: { runId, acknowledged, requestId: receiptRequest, nextDeliveryId: string(saved.deliveryId), nextCount: saved.count as number,
          source: "Orca request-showの保存check receipt（元ackと次Delivery）", observedAt: at() } };
      }
      if (method === "orchestration.reply") {
        const question = object(saved.question), answer = object(saved.message), receiptRequest = string(object(saved.mutation).requestId);
        const runId = string(question.run_id), dispatchId = string(question.dispatch_id), questionId = string(question.message_id);
        const answerMessageId = string(question.answer_message_id), body = string(question.answer_body);
        if (!runId || !dispatchId || !questionId || !answerMessageId || body === null || question.status !== "answered" || receiptRequest !== requestId
          || question.asker_handle !== `dispatch:${dispatchId}` || answer.id !== answerMessageId || answer.run_id !== runId
          || answer.thread_id !== questionId || answer.to_handle !== question.asker_handle || answer.body !== body) return base;
        return { ...base, reply: { runId, dispatchId, questionId, answerMessageId, body, status: "answered" as const, requestId: receiptRequest,
          source: "Orca request-showの保存reply receipt（質問・回答対応）", observedAt: at() } };
      }
      if (method !== "orchestration.workerRelease") return base;
      const dispatchId = string(saved.dispatchId), receiptRequest = string(object(saved.mutation).requestId), releaseState = string(saved.state);
      if (!dispatchId || !releaseState || receiptRequest !== requestId) return base;
      return { ...base, release: { dispatchId, state: releaseState, processAction: string(saved.processAction), requestId: receiptRequest,
        ...(saved.reason !== undefined ? { reason: string(saved.reason) } : {}),
        source: "Orca request-showの保存worker-release receipt（許可fieldのみ）", observedAt: at() } };
    },
    async release(_runId, dispatchId, retryRequestId) {
      const { result } = await call(["orchestration", "worker-release", "--dispatch", dispatchId,
        ...(retryRequestId ? ["--retry-request", retryRequestId] : [])], true);
      const requestId = string(object(result.mutation).requestId);
      if (result.dispatchId !== dispatchId || !string(result.state)) throw new SprintOrcaMutationError(requestId);
      return { dispatchId, state: result.state as string, processAction: string(result.processAction), requestId,
        ...(result.reason !== undefined ? { reason: string(result.reason) } : {}),
        source: "Orca worker-releaseの同Dispatch receipt", observedAt: at() };
    },
    async settlement(attempt) {
      if (!attempt.taskId || !attempt.dispatchId) return invalid();
      const { result } = await call(["orchestration", "worker-show", "--dispatch", attempt.dispatchId]);
      const dispatch = object(result.dispatch), projection = object(result.projection);
      if (dispatch.id !== attempt.dispatchId || dispatch.runId !== attempt.runId || (dispatch.taskId ?? dispatch.task_id) !== attempt.taskId
        || projection.taskId !== attempt.taskId || projection.dispatchId !== attempt.dispatchId) return invalid();
      const tasks = await allPages("task-list", attempt.runId);
      const matches = tasks.values.filter(t => t.id === attempt.taskId && (t.run_id ?? t.runId) === attempt.runId);
      if (!tasks.complete || matches.length !== 1) return invalid();
      const current = object((await call(["orchestration", "dispatch-show", "--task", attempt.taskId])).result.dispatch);
      if (current.id !== attempt.dispatchId || current.run_id !== attempt.runId || current.task_id !== attempt.taskId
        || current.status !== dispatch.status || (current.status !== "completed" && current.status !== "failed")) return invalid();
      const task = matches[0]!, outcome = projection.outcome;
      return { runId: attempt.runId, taskId: attempt.taskId, dispatchId: attempt.dispatchId,
        activeDispatchId: string(current.id), taskStatus: string(task.status), dispatchStatus: string(dispatch.status),
        outcome: outcome === "succeeded" || outcome === "failed" ? outcome : null,
        completedAt: string(dispatch.completedAt), source: "Orca task-list・dispatch-show --taskの現在Dispatch・worker-showのsettlement（端末livenessとは別）", observedAt: at() };
    },
    async reply(runId, messageId, body, retryRequestId) {
      if (!from) return invalid();
      const { result } = await call(["orchestration", "reply", "--id", messageId, "--body", body, "--run", runId,
        ...sender, ...(retryRequestId ? ["--retry-request", retryRequestId] : [])], true);
      const question = object(result.question), answer = object(result.message), requestId = string(object(result.mutation).requestId);
      if (question.message_id !== messageId || question.run_id !== runId || question.status !== "answered" || question.answer_body !== body
        || !string(question.answer_message_id) || answer.id !== question.answer_message_id || answer.thread_id !== messageId
        || answer.run_id !== runId || answer.body !== body || answer.to_handle !== question.asker_handle) throw new SprintOrcaMutationError(requestId);
      return { questionId: messageId, answerMessageId: question.answer_message_id as string, body, status: "answered", requestId,
        source: "Orca replyのquestion・回答message対応", observedAt: at() };
    },
    async check(runId) {
      if (!from) return invalid();
      return delivery((await call(["orchestration", "check", "--terminal", from, "--run", runId])).result, runId);
    },
    async acknowledge(runId, deliveryId, retryRequestId) {
      if (!from) return invalid();
      const { result } = await call(["orchestration", "check", "--terminal", from, "--run", runId, "--ack", deliveryId,
        ...(retryRequestId ? ["--retry-request", retryRequestId] : [])], true);
      const next = delivery(result, runId);
      return { acknowledged: string(result.acknowledged), next: next.deliveryId || next.count ? next : null,
        requestId: string(object(result.mutation).requestId), source: "Orca check --ackのmutation・現在Delivery receipt", observedAt: at() };
    },
    async status(messageId, runId) {
      if (!from) return invalid();
      const { result } = await call(["orchestration", "check", "--terminal", from, "--run", runId, "--all", "--types", "status"]);
      if (!Array.isArray(result.messages)) return invalid();
      const messages = result.messages.map(object).filter(m => m.id === messageId);
      if (messages.length !== 1) return null;
      const raw = messages[0]!;
      if (raw.run_id !== runId || !string(raw.from_handle) || raw.type !== "status") return invalid();
      return message(raw);
    },
    async host(attempt) {
      if (!attempt.dispatchId || !attempt.taskId) return invalid();
      const { result } = await call(["orchestration", "worker-show", "--dispatch", attempt.dispatchId]);
      const dispatch = object(result.dispatch), terminal = object(result.terminal), observation = object(result.observation);
      const projection = object(result.projection), live = object(projection.liveness), host = object(projection.host);
      if (dispatch.id !== attempt.dispatchId || dispatch.runId !== attempt.runId || (dispatch.taskId ?? dispatch.task_id) !== attempt.taskId) return invalid();
      const remote = host.kind === "remote";
      const target = remote ? string(object(result.server).environmentId) ?? string(host.id) : null;
      if (remote && !target) return invalid();
      // Run homeの_metaとremoteRuntimeEpochからruntime IDを作らず、実行hostのstatusを別に読む。
      const status = await call(["status"], false, target);
      const runtime = object(status.result.runtime);
      const verdict = live.verdict;
      const liveAt = typeof live.observedAt === "number" && Number.isFinite(live.observedAt)
        ? new Date(live.observedAt).toISOString() : string(live.observedAt);
      return { runId: attempt.runId, taskId: attempt.taskId, dispatchId: attempt.dispatchId,
        active: dispatch.status === "dispatched", exactWorker: observation.exactWorker === true && terminal.connected === true && runtime.reachable === true,
        identity: { terminal: string(terminal.handle), incarnationId: string(terminal.incarnationId), runtimeId: string(runtime.runtimeId), remoteRuntimeEpoch: string(result.remoteRuntimeEpoch) },
        cwd: string(terminal.worktreePath), agent: string(terminal.agentIdentity),
        liveness: verdict === "live" || verdict === "exited" ? verdict : "unverifiable",
        livenessSource: string(live.source), livenessObservedAt: liveAt,
        source: "Orca worker-showのexactWorker・実行host status（別取得）", observedAt: at() };
    },
    authority,
    async send(operation, retryRequestId) {
      if (retryRequestId && operation.requestId !== retryRequestId) throw new NodError("REQUEST_MISMATCH", "保存したrequest IDだけを回復できます");
      if (operation.callerEvidence) {
        const current = await authority(operation.runId);
        if (current.caller !== operation.caller || current.runtimeId !== operation.runtimeId
          || current.consumerGeneration !== operation.consumerGeneration || !sameSprintCaller(current, operation)) {
          return invalid("送信直前のcaller証拠が保存した操作と一致しません");
        }
      }
      const retry = retryRequestId ? ["--retry-request", retryRequestId] : [];
      if (operation.kind === "worker_begin") {
        if (!operation.start || !from || from !== operation.caller) return invalid();
        const args = sprintOrcaStartNotificationArgs(operation);
        const response = await call([...args, ...retry], true);
        const parsed = receipt(response.result, null, { dispatchId: operation.start.dispatchId, destination: "worker", runId: operation.runId, from,
          payload: object(JSON.parse(args[args.indexOf("--payload") + 1]!)) });
        if (!parsed.notification || parsed.notification.toHandle !== `dispatch:${operation.start.dispatchId}`) throw new SprintOrcaMutationError(parsed.requestId);
        return { ...parsed, runId: operation.runId, taskId: operation.input.taskId, dispatchId: operation.start.dispatchId };
      }
      const placement = operation.input.placement;
      const args = operation.kind === "task_create"
        ? ["orchestration", "task-create", "--spec", sprintOrcaTaskSpec(operation), "--run", operation.runId,
          ...(operation.input.parentTaskId ? ["--parent", operation.input.parentTaskId] : []), ...sender, ...retry]
        : ["orchestration", "worker-start", "--task", operation.input.taskId!, "--run", operation.runId,
          "--worktree", placement.worktree, "--agent", placement.agent, ...(placement.on ? ["--on", placement.on] : []),
          ...(placement.model ? ["--model", placement.model] : []), ...(placement.effort ? ["--effort", placement.effort] : []), ...sender, ...retry];
      const response = await call(args, true);
      return receipt(response.result);
    },
    async inventory(runId, targets): Promise<SprintOrcaInventory> {
      const tasks = await allPages("task-list", runId), workers = await allPages("worker-list", runId);
      const inventory: SprintOrcaInventory = { complete: tasks.complete && workers.complete,
        tasks: tasks.values.flatMap(t => {
          const taskId = string(t.id), taskRun = string(t.run_id ?? t.runId), spec = string(t.spec);
          return taskId && taskRun === runId ? [{ taskId, runId, spec: t.spec_truncated === true ? null : spec,
            parentTaskId: string(t.parent_id ?? t.parent_task_id ?? t.parentTaskId) }] : [];
        }),
        workers: workers.values.flatMap(w => {
          const projection = object(w.projection), taskId = string(w.taskId ?? projection.taskId), dispatchId = string(w.dispatchId ?? projection.dispatchId);
          if (!taskId || !dispatchId || (w.runId ?? projection.runId) !== runId) return [];
          const liveness = object(projection.liveness), verdict = liveness.verdict;
          const observed = liveness.observedAt ?? object(projection.evidence).lastObservedAt;
          const observedAt = typeof observed === "number" && Number.isFinite(observed) ? new Date(observed).toISOString() : string(observed);
          return [{ runId, taskId, dispatchId, identity: identity(w.identity ?? w),
            liveness: (verdict === "live" || verdict === "exited") && observedAt ? verdict : "unverifiable",
            source: "Orca worker-list --include-remote", observedAt: observedAt ?? at() }];
        }),
      };
      for (const worker of inventory.workers) {
        if (!targets?.some(t => t.taskId === worker.taskId && (!t.dispatchId || t.dispatchId === worker.dispatchId))
          || ((worker.identity.runtimeId || worker.identity.remoteRuntimeEpoch) && worker.identity.incarnationId)) continue;
        try {
          const shown = await call(["orchestration", "worker-show", "--dispatch", worker.dispatchId]);
          const dispatch = object(shown.result.dispatch), terminal = object(shown.result.terminal), observation = object(shown.result.observation);
          if (dispatch.id !== worker.dispatchId || dispatch.runId !== runId || (dispatch.taskId ?? dispatch.task_id) !== worker.taskId
            || observation.exactWorker !== true || (worker.identity.terminal && terminal.handle !== worker.identity.terminal)) {
            worker.liveness = "unverifiable"; continue;
          }
          // remoteRuntimeEpochはruntime IDへコピーしない。Run homeの_metaやworker.runtimeEpochもhostのruntime IDではない。
          worker.identity = { runtimeId: string(object(shown.result.executionHost).runtimeId),
            remoteRuntimeEpoch: string(shown.result.remoteRuntimeEpoch), terminal: string(terminal.handle), incarnationId: string(terminal.incarnationId) };
          const live = object(object(shown.result.projection).liveness), observed = live.observedAt;
          if ((live.verdict === "live" || live.verdict === "exited") && typeof observed === "number" && Number.isFinite(observed)) {
            worker.liveness = live.verdict; worker.observedAt = new Date(observed).toISOString();
          }
          worker.source = "Orca worker-list --include-remote・worker-showの正確な担当観測";
        } catch { worker.liveness = "unverifiable"; }
      }
      return inventory;
    },
    async request(requestId): Promise<SprintRequestObservation> {
      const { result } = await call(["orchestration", "request-show", "--request", requestId]);
      const state = result.state;
      if (result.requestId !== requestId || !["absent", "pending", "completed"].includes(String(state))) return invalid();
      return { requestId, state: state as SprintRequestObservation["state"],
        receipt: state === "completed" ? receipt(result.receipt ?? result.result, requestId) : null,
        source: "Orca request-show（現在のcaller）", observedAt: at() };
    },
  };
}
