import { expect, test } from "bun:test";
import * as core from "../src/index";
import { setup } from "./helpers";
import { prepareSprint, sprintTestClock as clock } from "./fixtures/sprint-start";

const at = clock.now.toISOString();
const identity = { terminal: "worker-terminal", incarnationId: "incarnation", runtimeId: "host-runtime", remoteRuntimeEpoch: null };
async function worker(inherit = false, allowedEfforts = ["high"]) {
  const s = setup(), issue = core.createIssue(s.me, { workspaceId: s.ws.id, title: "観測後に開始する仕事" });
  const prepared = prepareSprint(s.me, s.ws.key, [issue.id]);
  const constraints = inherit ? { ...prepared.input.constraints, executionSettingsPolicy: { version: "継承方針v1", agent: "codex", allowedModels: ["gpt-6.1-sol"], allowedEfforts, allowedTargets: ["studio"] } }
    : { ...prepared.input.constraints, model: "gpt-6.1-sol", effort: "high", executionTarget: "studio" };
  const proposal = core.proposeSprintPlan(s.me, prepared.sprint.id, { ...prepared.input, expectedVersion: prepared.sprint.version, requestKey: "設定を合意", constraints });
  const ready = core.acceptSprintPlan(s.me, proposal.sprint.id, proposal.plan.id, { expectedVersion: proposal.sprint.version, requestKey: "合意", contentHash: proposal.plan.contentHash });
  const sprint = core.activateSprint(s.me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, clock);
  const authority = { runId: "run", caller: "PM", coordinator: "PM", consumerGeneration: 1, runtimeId: "home", source: "Orca", observedAt: at };
  const sends: core.SprintExecutionOperation[] = [];
  const messages = new Map<string, any>();
  const host = { runId: "run", taskId: "task", dispatchId: "dispatch", identity, cwd: "/専用", agent: "codex", active: true, exactWorker: true,
    liveness: "live" as const, source: "独立Orca worker-showとhost status", observedAt: at, livenessSource: "execution_host", livenessObservedAt: at };
  const adapter: core.SprintOrcaAdapter = { authority: async () => authority,
    send: async operation => { sends.push(operation); return { runId: "run", taskId: "task", dispatchId: operation.kind === "task_create" ? null : "dispatch",
      requestId: "request:" + operation.id, requested: null, effective: null, identity: null, source: "起動receipt", receivedAt: at,
      ...(operation.kind === "worker_begin" ? { notification: { messageId: "開始通知", toHandle: "dispatch:dispatch", accepted: true as const } } : {}) }; },
    status: async id => messages.get(id), host: async () => host,
  };
  const session = await core.beginSprintSession(s.llm, sprint.id, { expectedVersion: sprint.version, requestKey: "監督", runId: "run" }, adapter, clock);
  const context = { sessionId: session.id, generation: 1 };
  const attempt = core.prepareSprintExecution(s.llm, sprint.id, { ...context, requestKey: "予約", itemId: prepared.items[0]!.id, actor: s.llm.actor, spec: "仕事", placement: { agent: "codex", worktree: "path:/専用", on: "studio", model: "gpt-6.1-sol", effort: "high" } }, clock);
  await core.requestSprintExecution(s.llm, sprint.id, { ...context, attemptId: attempt.id }, adapter, clock);
  const metadata: core.SprintSelfMetadata = { schemaVersion: 1, status: "observed", reasons: [], threadId: "thread", turnId: "turn", terminal: identity.terminal, cwd: "/専用", model: "gpt-6.1-sol", effort: "high", provider: "openai", cliVersion: "0.164.0", settingsAppliedAt: at, collectedAt: at, collectorDigest: "a".repeat(64), metadataDigest: "b".repeat(64), source: "provider metadata", association: "thread/context/usage" };
  const message = (id: string, extra = {}) => {
    const m = { id, runId: "run", fromHandle: "dispatch:dispatch", type: "status", receivedAt: at,
      payload: { kind: "nod.sprint.host-observation", schemaVersion: 1, sprintId: sprint.id, attemptId: attempt.id, runId: "run", taskId: "task", dispatchId: "dispatch", metadata,
        host: { identity, cwd: "/専用", source: "自己host status/terminal", observedAt: at }, ...extra } };
    messages.set(id, m); return m;
  };
  return { ...s, sprint, issue, session, attempt, context, adapter, sends, host, message, metadata, messages };
}

test("実envelopeと独立hostが一致した同担当だけ、取り直した観測で開始通知へ進む", async () => {
  const s = await worker(); s.message("初観測");
  let state = await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: "初観測" }, s.adapter, clock);
  expect(state.attempts[0]?.hostObservation?.result).toBe("matched");
  expect(state.operations[1]?.receipt).toMatchObject({ requested: null, effective: null });
  const confirmation = core.prepareSprintStartConfirmation(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id }, clock);
  s.message("開始直前", { confirmationId: confirmation.id });
  state = await core.requestSprintExecutionStart(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id, messageId: "開始直前", confirmationId: confirmation.id }, s.adapter, clock);
  expect(s.sends.map(o => o.kind)).toEqual(["task_create", "worker_start", "worker_begin"]);
  expect(state.attempts[0]).toMatchObject({ phase: "start_authorized", canStart: true, startAuthorization: { confirmationId: confirmation.id } });
  expect(core.getIssue(s.db, s.issue.id).status).toBe("todo");
  expect(state).toMatchObject({ occupied: 1, reserved: 1 });
  s.db.close();
});

test("公開Orca adapterは実受信箱とworker-show・host statusを別取得し、epochを合成しない", async () => {
  const s = await worker(), commands: string[][] = [];
  const message = s.message("実status");
  const runner: core.OrcaRunner = async args => {
    commands.push(args); let result: unknown;
    if (args[1] === "check") result = { messages: [{ id: message.id, run_id: "run", from_handle: message.fromHandle, type: "status", payload: message.payload }] };
    else if (args[1] === "worker-show") result = { dispatch: { id: "dispatch", runId: "run", taskId: "task", status: "dispatched" },
      terminal: { handle: identity.terminal, incarnationId: identity.incarnationId, worktreePath: "/専用", agentIdentity: "codex", connected: true },
      observation: { status: "live", exactWorker: true }, projection: { host: { kind: "remote", id: "studio" }, liveness: { verdict: "live", observedAt: clock.now.getTime(), source: "execution_host" } }, server: { environmentId: "studio" } };
    else if (args[0] === "status" && args.includes("studio")) result = { runtime: { runtimeId: "host-runtime", reachable: true } };
    else throw Error("想定外の外部操作");
    return { kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result, _meta: { runtimeId: "home" } }), stderr: "" };
  };
  const adapter = core.createSprintOrcaAdapter(runner, { from: "PM", clock });
  const state = await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: message.id }, adapter, clock);
  expect(state.attempts[0]?.hostObservation).toMatchObject({ result: "matched", independent: { identity: { runtimeId: "host-runtime", remoteRuntimeEpoch: null }, liveness: "live", livenessSource: "execution_host", livenessObservedAt: at } });
  expect(commands.some(a => a[1] === "check" && a.includes("--all"))).toBe(true);
  expect(commands.some(a => a[0] === "status" && a.includes("--environment"))).toBe(true);
  s.db.close();
});

test("実送信元の偽装は拒否し、設定不一致・独立host欠測・配置違いは所有と枠を保持する", async () => {
  const s = await worker();
  const forged = s.message("偽装"); forged.fromHandle = "dispatch:別担当";
  await expect(core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: forged.id }, s.adapter, clock)).rejects.toMatchObject({ code: "WORKER_MISMATCH" });
  const mismatch = s.message("設定違い"); mismatch.payload.metadata = { ...s.metadata, effort: "low" };
  let state = await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: mismatch.id }, s.adapter, clock);
  expect(state.attempts[0]?.hostObservation?.result).toBe("mismatched");
  s.message("host欠測");
  state = await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: "host欠測" }, { ...s.adapter, host: undefined }, clock);
  expect(state.attempts[0]?.hostObservation?.result).toBe("unavailable");
  const moved = s.message("配置違い"); moved.payload.metadata = { ...s.metadata, cwd: "/別作業" }; moved.payload.host = { ...moved.payload.host, cwd: "/別作業" };
  state = await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: moved.id }, { ...s.adapter, host: async () => ({ ...s.host, cwd: "/別作業" }) }, clock);
  expect(state.attempts[0]?.hostObservation?.result).toBe("mismatched");
  expect(state).toMatchObject({ canStart: false, occupied: 1, reserved: 1 });
  expect(s.sends).toHaveLength(2); s.db.close();
});

test("開始許可後も期限超過は開始不可として返し、開始済み表示や枠解放に変えない", async () => {
  const s = await worker(); s.message("初観測");
  await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: "初観測" }, s.adapter, clock);
  const confirmation = core.prepareSprintStartConfirmation(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id }, clock);
  s.message("直前", { confirmationId: confirmation.id });
  await core.requestSprintExecutionStart(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id, messageId: "直前", confirmationId: confirmation.id }, s.adapter, clock);
  const state = core.getSprintExecutionState(s.db, s.sprint.id, { now: new Date("2026-03-10T12:00:00Z") });
  expect(state).toMatchObject({ canStart: false, occupied: 1, reserved: 1, attempts: [{ canStart: false, phase: "start_authorized" }] });
  expect(state.attempts[0]?.startedReport).toBeUndefined(); s.db.close();
});

test("再取得時刻で古いlive判定を新しくせず、exitedとunverifiableも原観測を保持する", async () => {
  const s = await worker();
  for (const [id, changed] of [
    ["古いlive", { livenessObservedAt: "2026-03-08T11:00:00Z" }],
    ["終了", { liveness: "exited" as const }], ["不明", { liveness: "unverifiable" as const }],
  ] as const) {
    s.message(id);
    const state = await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: id }, { ...s.adapter, host: async () => ({ ...s.host, ...changed }) }, clock);
    expect(state.attempts[0]?.hostObservation).toMatchObject({ result: "unavailable", independent: changed });
    expect(state).toMatchObject({ occupied: 1, reserved: 1, canStart: false });
  }
  expect(s.sends).toHaveLength(2); s.db.close();
});

test("開始通知応答の喪失を同じrequestへ照合し、Task一覧だけでは通知済みにしない", async () => {
  const s = await worker(); s.message("初観測");
  await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: "初観測" }, s.adapter, clock);
  const confirmation = core.prepareSprintStartConfirmation(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id }, clock);
  s.message("直前", { confirmationId: confirmation.id });
  const adapter: core.SprintOrcaAdapter = { ...s.adapter,
    send: async o => { if (o.kind === "worker_begin") { s.sends.push(o); throw new core.SprintOrcaMutationError("通知request"); } return s.adapter.send!(o); },
    inventory: async () => ({ complete: true, tasks: [{ runId: "run", taskId: "task", spec: s.sends[0] ? core.sprintOrcaTaskSpec(s.sends[0]) : null, parentTaskId: null }], workers: [s.host] }),
    request: async requestId => ({ requestId, state: "absent", receipt: null, source: "別caller", observedAt: at }),
  };
  const input = { ...s.context, attemptId: s.attempt.id, messageId: "直前", confirmationId: confirmation.id };
  let state = await core.requestSprintExecutionStart(s.llm, s.sprint.id, input, adapter, clock);
  const operation = state.operations.find(o => o.kind === "worker_begin")!;
  expect(operation).toMatchObject({ state: "unknown", requestId: "通知request" });
  state = await core.reconcileSprintExecution(s.llm, s.sprint.id, s.context, adapter, clock);
  expect(state.operations.find(o => o.id === operation.id)?.state).toBe("unknown");
  const nextAuthority = await s.adapter.authority("run");
  const resume = await core.resumeSprintSession(s.llm, s.sprint.id, { ...s.context, requestKey: "通知不明の交代" }, {
    ...adapter, authority: async () => ({ ...nextAuthority, caller: "次PM", coordinator: "次PM", consumerGeneration: 2 }),
  }, clock);
  expect(resume.snapshot.resolved).toBe(false);
  expect(resume.state.session?.generation).toBe(1);
  // この試行は引継ぎ待ちを維持し、外部で肯定的に確認した元receiptだけを採用する。
  adapter.request = async requestId => ({ requestId, state: "completed", receipt: { runId: null, taskId: null, dispatchId: null, requestId, requested: null, effective: null, identity: null, source: "元通知のreceipt", receivedAt: at,
    notification: { messageId: "元通知", toHandle: "dispatch:dispatch", accepted: true } }, source: "Orca request-show", observedAt: at });
  state = await core.reconcileSprintExecution(s.llm, s.sprint.id, s.context, adapter, clock);
  expect(state.operations.find(o => o.id === operation.id)).toMatchObject({ state: "confirmed", requestId: "通知request" });
  await expect(core.requestSprintExecutionStart(s.llm, s.sprint.id, input, adapter, clock)).rejects.toMatchObject({ code: "HANDOVER_PENDING" });
  expect(s.sends.filter(o => o.kind === "worker_begin")).toHaveLength(1);
  expect(state.attempts[0]?.startedReport).toBeUndefined(); expect(state.occupied).toBe(1); s.db.close();
});

test("開始直前のidentity・設定変化とIssue条件変更は通知せず、再照合理由と同予約を返す", async () => {
  for (const variation of ["thread", "turn", "collector", "runtime", "incarnation", "settings", "ended", "issue", "last_host"]) {
    const s = await worker(); s.message("初観測");
    await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: "初観測" }, s.adapter, clock);
    const confirmation = core.prepareSprintStartConfirmation(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id }, clock);
    const m = s.message("直前", { confirmationId: confirmation.id });
    if (variation === "thread") m.payload.metadata = { ...s.metadata, threadId: "別thread" };
    if (variation === "turn") m.payload.metadata = { ...s.metadata, turnId: "別turn" };
    if (variation === "collector") m.payload.metadata = { ...s.metadata, collectorDigest: "c".repeat(64) };
    if (variation === "settings") m.payload.metadata = { ...s.metadata, effort: "low" };
    if (variation === "ended") m.payload.metadata = { ...s.metadata, status: "unknown", reasons: ["active_turn_ended"] };
    let host = s.host;
    if (variation === "runtime" || variation === "incarnation") {
      const changed = { ...identity, [variation === "runtime" ? "runtimeId" : "incarnationId"]: "新identity" };
      m.payload.host = { ...m.payload.host, identity: changed }; host = { ...host, identity: changed };
    }
    let reads = 0;
    const adapter = { ...s.adapter, host: async () => {
      reads++;
      if (reads === 2 && variation === "issue") core.updateIssue(s.me, s.issue.id, { assignee: "別担当" });
      return reads === 2 && variation === "last_host" ? { ...host, identity: { ...identity, incarnationId: "送信直前の再利用" } } : host;
    } };
    const state = await core.requestSprintExecutionStart(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id, messageId: "直前", confirmationId: confirmation.id }, adapter, clock);
    expect(state.canStart).toBe(false); expect(state.occupied).toBe(1); expect(state.reserved).toBe(1);
    expect(state.attempts[0]?.reason.code).not.toBe("START_AUTHORIZED");
    expect(state.nextActions.length).toBeGreaterThan(0); expect(s.sends).toHaveLength(2); s.db.close();
  }
});

test("人が合意した継承方針の版と許可範囲を要求として保存し、範囲外の観測を拒否する", async () => {
  const s = await worker(true); s.message("継承観測");
  let state = await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: "継承観測" }, s.adapter, clock);
  expect(state.attempts[0]).toMatchObject({ settingsRequirement: { mode: "inherit", policy: { version: "継承方針v1" } }, hostObservation: { result: "matched" } });
  const outside = s.message("範囲外"); outside.payload.metadata = { ...s.metadata, effort: "low" };
  state = await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: outside.id }, s.adapter, clock);
  expect(state.attempts[0]?.hostObservation?.result).toBe("mismatched");
  expect(state.occupied).toBe(1); expect(s.sends).toHaveLength(2); s.db.close();
});

test("開始operationのOrca adapterはworkerを再起動せず同Dispatch宛statusを送る", async () => {
  const s = await worker(); s.message("初観測");
  await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: "初観測" }, s.adapter, clock);
  const confirmation = core.prepareSprintStartConfirmation(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id }, clock);
  s.message("直前", { confirmationId: confirmation.id });
  await core.requestSprintExecutionStart(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id, messageId: "直前", confirmationId: confirmation.id }, s.adapter, clock);
  const commands: string[][] = [];
  const adapter = core.createSprintOrcaAdapter(async args => {
    commands.push(args);
    return { kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result: { accepted: true, relay: { destination: "worker", dispatchId: "dispatch", messageId: "開始通知" }, mutation: { requestId: "通知request" } } }), stderr: "" };
  }, { from: "PM", clock });
  const receipt = await adapter.send!(s.sends.at(-1)!);
  expect(commands[0]?.slice(0, 2)).toEqual(["orchestration", "send"]);
  expect(commands[0]).toContain("dispatch:dispatch"); expect(commands[0]).not.toContain("worker-start");
  expect(receipt).toMatchObject({ runId: "run", taskId: "task", dispatchId: "dispatch", requestId: "通知request", notification: { messageId: "開始通知", toHandle: "dispatch:dispatch", accepted: true } });
  s.db.close();
});

test("監督交代後も同workerの正当な開始報告を受理し、旧監督の新規許可は拒否する", async () => {
  const s = await worker(); s.message("初観測");
  await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: "初観測" }, s.adapter, clock);
  const confirmation = core.prepareSprintStartConfirmation(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id }, clock);
  s.message("直前", { confirmationId: confirmation.id });
  const input = { ...s.context, attemptId: s.attempt.id, messageId: "直前", confirmationId: confirmation.id };
  const started = await core.requestSprintExecutionStart(s.llm, s.sprint.id, input, s.adapter, clock);
  const authorization = started.attempts[0]!.startAuthorization!;
  const authority = await s.adapter.authority("run");
  const adapter = { ...s.adapter, authority: async () => ({ ...authority, caller: "次PM", coordinator: "次PM", consumerGeneration: 2 }),
    inventory: async () => ({ complete: true, tasks: [{ runId: "run", taskId: "task", spec: core.sprintOrcaTaskSpec(s.sends[0]!), parentTaskId: null }], workers: [s.host] }) };
  const resumed = await core.resumeSprintSession(s.llm, s.sprint.id, { ...s.context, requestKey: "引継ぎ" }, adapter, clock);
  expect(resumed.state.session?.generation).toBe(2);
  await expect(core.requestSprintExecutionStart(s.llm, s.sprint.id, input, adapter, clock)).rejects.toMatchObject({ code: "STALE_GENERATION" });
  const report = s.message("開始報告", { kind: "nod.sprint.worker-started", authorizationId: authorization.id });
  const state = await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: report.id }, adapter, clock);
  expect(state.attempts[0]).toMatchObject({ phase: "implementing", startedReport: { authorizationId: authorization.id, messageId: report.id } });
  const replay = await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: report.id }, adapter, clock);
  expect(replay.attempts[0]?.observationHistory?.length).toBe(state.attempts[0]?.observationHistory?.length);
  const reconciled = await core.reconcileSprintExecution(s.llm, s.sprint.id, { sessionId: s.session.id, generation: 2 }, adapter, clock);
  expect(reconciled.attempts[0]?.phase).toBe("implementing");
  const changed = await core.reconcileSprintExecution(s.llm, s.sprint.id, { sessionId: s.session.id, generation: 2 }, { ...adapter,
    inventory: async () => ({ ...(await adapter.inventory()), workers: [{ ...s.host, identity: { ...identity, incarnationId: "再利用後" } }] }) }, clock);
  expect(changed.attempts[0]?.hostObservation?.result).toBe("unavailable");
  expect(changed.occupied).toBe(1);
  expect(s.sends).toHaveLength(3); s.db.close();
});

test("開始通知のpending回復は非稼働証拠と同じliteral送信手順だけで元requestへ合流する", async () => {
  const s = await worker(); s.message("初観測");
  await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: "初観測" }, s.adapter, clock);
  const confirmation = core.prepareSprintStartConfirmation(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id }, clock);
  s.message("直前", { confirmationId: confirmation.id });
  const retries: (string | undefined)[] = []; let operation: core.SprintExecutionOperation; let proof = false;
  const adapter: core.SprintOrcaAdapter = { ...s.adapter, send: async (o, retry) => {
    operation = o; retries.push(retry);
    if (!retry) throw new core.SprintOrcaMutationError("通知request");
    return { runId: "run", taskId: "task", dispatchId: "dispatch", requestId: retry, requested: null, effective: null, identity: null,
      source: "同通知receipt", receivedAt: at, notification: { messageId: "同通知", toHandle: "dispatch:dispatch", accepted: true } };
  }, inventory: async () => ({ complete: true, tasks: [{ runId: "run", taskId: "task", spec: core.sprintOrcaTaskSpec(s.sends[0]!), parentTaskId: null }], workers: [s.host] }),
    request: async requestId => ({ state: "pending", requestId, receipt: null, source: "Orca", observedAt: at,
      ...(proof ? { recovery: { originalInactive: true as const, evidence: "元送信processの終了を独立確認", argv: ["orca", "orchestration", "send", "--to", "dispatch:dispatch", "--run", "run", "--from", "PM", "--type", "status", "--subject", "Sprint実装開始の許可", "--payload", JSON.stringify({ kind: "nod.sprint.start-authorization", schemaVersion: 1, runId: "run", taskId: "task", dispatchId: "dispatch", attemptId: s.attempt.id, authorization: operation.start!.authorization }), "--retry-request", "通知request", "--json"] } } : {}) }),
  };
  await core.requestSprintExecutionStart(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id, messageId: "直前", confirmationId: confirmation.id }, adapter, clock);
  await core.recoverSprintExecution(s.llm, s.sprint.id, { ...s.context, operationId: operation!.id }, adapter, clock);
  expect(retries).toEqual([undefined]); proof = true;
  const recovered = await core.recoverSprintExecution(s.llm, s.sprint.id, { ...s.context, operationId: operation!.id }, adapter, clock);
  expect(retries).toEqual([undefined, "通知request"]);
  expect(recovered.operations.find(o => o.kind === "worker_begin")).toMatchObject({ id: operation!.id, state: "confirmed", requestId: "通知request" });
  expect(recovered.attempts[0]).toMatchObject({ phase: "start_authorized", canStart: true });
  expect(recovered.occupied).toBe(1); s.db.close();
});

test("同条件の新合意を引き継いだ後は要求の版を更新し、旧観測で開始確認を作らない", async () => {
  const s = await worker(); s.message("初観測");
  await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: "初観測" }, s.adapter, clock);
  const current = core.getSprint(s.db, s.sprint.id), plan = current.plans.find(p => p.id === current.adoptedPlanId)!;
  const next = core.proposeSprintPlan(s.me, current.id, { expectedVersion: current.version, requestKey: "新計画", goal: "新しいゴール", verificationMethod: plan.content.verificationMethod,
    items: plan.content.items.map(i => ({ itemId: i.itemId, contribution: i.contribution, executionPlan: i.executionPlan })), definitionOfDone: plan.content.definitionOfDone,
    constraints: plan.content.constraints, changeReason: "同条件で合意を更新" });
  core.acceptSprintPlan(s.me, current.id, next.plan.id, { expectedVersion: next.sprint.version, requestKey: "新合意", contentHash: next.plan.contentHash });
  const adapter = { ...s.adapter, inventory: async () => ({ complete: true, tasks: [{ runId: "run", taskId: "task", spec: core.sprintOrcaTaskSpec(s.sends[0]!), parentTaskId: null }], workers: [s.host] }) };
  const result = await core.resumeSprintSession(s.llm, s.sprint.id, { ...s.context, requestKey: "新合意へ合流" }, adapter, clock);
  expect(result.state.session?.generation).toBe(2);
  expect(result.state.attempts[0]?.settingsRequirement).toMatchObject({ planId: next.plan.id, planHash: next.plan.contentHash });
  expect(() => core.prepareSprintStartConfirmation(s.llm, s.sprint.id, { sessionId: s.session.id, generation: 2, attemptId: s.attempt.id }, clock)).toThrow();
  expect(result.state.attempts[0]?.id).toBe(s.attempt.id); expect(s.sends).toHaveLength(2); s.db.close();
});

test("開始報告の確定も現在のIssue着手条件を通し、担当変更後は実装中へ更新しない", async () => {
  const s = await worker(); s.message("初観測");
  await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: "初観測" }, s.adapter, clock);
  const confirmation = core.prepareSprintStartConfirmation(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id }, clock);
  s.message("直前", { confirmationId: confirmation.id });
  const state = await core.requestSprintExecutionStart(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id, messageId: "直前", confirmationId: confirmation.id }, s.adapter, clock);
  core.updateIssue(s.me, s.issue.id, { assignee: "人が変更した担当" });
  s.message("変更後報告", { kind: "nod.sprint.worker-started", authorizationId: state.attempts[0]!.startAuthorization!.id });
  const rejected = await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: "変更後報告" }, s.adapter, clock);
  expect(rejected.attempts[0]?.phase).not.toBe("implementing");
  expect(rejected.attempts[0]?.startedReport).toBeUndefined(); expect(rejected.occupied).toBe(1); s.db.close();
});

test("新合意の継承範囲が元の要求設定を外す場合も同試行の旧要求を保持して引継ぎを拒否する", async () => {
  const s = await worker(true), current = core.getSprint(s.db, s.sprint.id), plan = current.plans.find(p => p.id === current.adoptedPlanId)!;
  const next = core.proposeSprintPlan(s.me, current.id, { expectedVersion: current.version, requestKey: "継承範囲を変更", goal: plan.content.goal, verificationMethod: plan.content.verificationMethod,
    items: plan.content.items.map(i => ({ itemId: i.itemId, contribution: i.contribution, executionPlan: i.executionPlan })), definitionOfDone: plan.content.definitionOfDone,
    constraints: { ...plan.content.constraints, executionSettingsPolicy: { ...plan.content.constraints.executionSettingsPolicy!, allowedEfforts: ["low"] } }, changeReason: "人が範囲を変更" });
  core.acceptSprintPlan(s.me, current.id, next.plan.id, { expectedVersion: next.sprint.version, requestKey: "新合意", contentHash: next.plan.contentHash });
  const adapter = { ...s.adapter, inventory: async () => ({ complete: true, tasks: [{ runId: "run", taskId: "task", spec: core.sprintOrcaTaskSpec(s.sends[0]!), parentTaskId: null }], workers: [s.host] }) };
  const result = await core.resumeSprintSession(s.llm, s.sprint.id, { ...s.context, requestKey: "変更後照合" }, adapter, clock);
  expect(result.snapshot).toMatchObject({ resolved: false, reason: { code: "EXECUTION_SETTINGS_CHANGED" } });
  expect(result.state.session?.generation).toBe(1); expect(result.state.attempts[0]?.placement.effort).toBe("high");
  expect(s.sends).toHaveLength(2); s.db.close();
});

test("実開始許可後にゴールだけの正式新合意へ引き継いでも同workerの正当な開始報告を受理する", async () => {
  const s = await worker(); s.message("初観測");
  await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: "初観測" }, s.adapter, clock);
  const confirmation = core.prepareSprintStartConfirmation(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id }, clock);
  s.message("直前", { confirmationId: confirmation.id });
  const authorized = await core.requestSprintExecutionStart(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id, messageId: "直前", confirmationId: confirmation.id }, s.adapter, clock);
  const authorization = authorized.attempts[0]!.startAuthorization!;
  const current = core.getSprint(s.db, s.sprint.id), plan = current.plans.find(p => p.id === current.adoptedPlanId)!;
  const next = core.proposeSprintPlan(s.me, current.id, { expectedVersion: current.version, requestKey: "許可後の新計画", goal: "正式に更新したゴール", verificationMethod: plan.content.verificationMethod,
    items: plan.content.items.map(i => ({ itemId: i.itemId, contribution: i.contribution, executionPlan: i.executionPlan })), definitionOfDone: plan.content.definitionOfDone,
    constraints: plan.content.constraints, changeReason: "同じ要求と設定のままゴールだけ更新" });
  core.acceptSprintPlan(s.me, current.id, next.plan.id, { expectedVersion: next.sprint.version, requestKey: "許可後の正式合意", contentHash: next.plan.contentHash });
  const adapter = { ...s.adapter, inventory: async () => ({ complete: true, tasks: [{ runId: "run", taskId: "task", spec: core.sprintOrcaTaskSpec(s.sends[0]!), parentTaskId: null }], workers: [s.host] }) };
  const resumed = await core.resumeSprintSession(s.llm, s.sprint.id, { ...s.context, requestKey: "許可済み同担当を引継ぎ" }, adapter, clock);
  expect(resumed.state.session).toMatchObject({ generation: 2, planId: next.plan.id });
  const report = s.message("新合意後の開始報告", { kind: "nod.sprint.worker-started", authorizationId: authorization.id });
  const actual = await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: report.id }, adapter, clock);
  expect(actual.attempts[0]).toMatchObject({ phase: "implementing", startedReport: { authorizationId: authorization.id, messageId: report.id } });
  expect(actual.attempts[0]?.startAuthorization).toEqual(authorization);
  expect(actual.attempts[0]?.planHistory).toContainEqual(expect.objectContaining({ planId: plan.id, planHash: plan.contentHash }));
  expect(actual.operations.map(o => [o.id, o.requestId, o.inputHash])).toEqual(authorized.operations.map(o => [o.id, o.requestId, o.inputHash]));
  expect(s.sends).toHaveLength(3); expect(actual.occupied).toBe(1); s.db.close();
});

test("ゴール更新後も実設定・権限範囲・identity・期間が変わった開始報告へ旧許可を流用しない", async () => {
  for (const variation of ["applied_settings", "scope", "identity", "expired"]) {
    const s = await worker(true, ["high", "low"]); s.message("初観測");
    await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: "初観測" }, s.adapter, clock);
    const confirmation = core.prepareSprintStartConfirmation(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id }, clock);
    s.message("直前", { confirmationId: confirmation.id });
    const authorized = await core.requestSprintExecutionStart(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id, messageId: "直前", confirmationId: confirmation.id }, s.adapter, clock);
    const authorization = authorized.attempts[0]!.startAuthorization!;
    const current = core.getSprint(s.db, s.sprint.id), plan = current.plans.find(p => p.id === current.adoptedPlanId)!;
    const next = core.proposeSprintPlan(s.me, current.id, { expectedVersion: current.version, requestKey: "新計画", goal: "更新したゴール", verificationMethod: plan.content.verificationMethod,
      items: plan.content.items.map(i => ({ itemId: i.itemId, contribution: i.contribution, executionPlan: i.executionPlan })), definitionOfDone: plan.content.definitionOfDone,
      constraints: variation === "scope" ? { ...plan.content.constraints, executionScope: "別の権限範囲" } : plan.content.constraints, changeReason: "人が正式合意" });
    core.acceptSprintPlan(s.me, current.id, next.plan.id, { expectedVersion: next.sprint.version, requestKey: "正式合意", contentHash: next.plan.contentHash });
    const adapter = { ...s.adapter, inventory: async () => ({ complete: true, tasks: [{ runId: "run", taskId: "task", spec: core.sprintOrcaTaskSpec(s.sends[0]!), parentTaskId: null }], workers: [s.host] }) };
    await core.resumeSprintSession(s.llm, s.sprint.id, { ...s.context, requestKey: "新合意へ引継ぎ" }, adapter, clock);
    const report = s.message("変更後報告", { kind: "nod.sprint.worker-started", authorizationId: authorization.id });
    if (variation === "applied_settings") report.payload.metadata = { ...s.metadata, effort: "low" };
    if (variation === "identity") report.payload.metadata = { ...s.metadata, threadId: "別thread" };
    const reportClock = variation === "expired" ? { now: new Date("2026-03-10T12:00:00Z") } : clock;
    const reportedAt = reportClock.now.toISOString();
    report.receivedAt = reportedAt; report.payload.metadata = { ...report.payload.metadata, collectedAt: reportedAt };
    report.payload.host = { ...report.payload.host, observedAt: reportedAt };
    const rejected = await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: report.id }, { ...adapter,
      host: async () => ({ ...s.host, observedAt: reportedAt, livenessObservedAt: reportedAt }) }, reportClock);
    expect(rejected.attempts[0]?.phase).not.toBe("implementing"); expect(rejected.attempts[0]?.startedReport).toBeUndefined();
    expect(rejected.attempts[0]?.startAuthorization).toEqual(authorization);
    expect(rejected.occupied).toBe(1); expect(s.sends).toHaveLength(3); s.db.close();
  }
});
