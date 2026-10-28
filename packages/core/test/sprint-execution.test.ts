import { expect, test } from "bun:test";
import * as core from "../src/index";
import { setup, codeOf } from "./helpers";
import { prepareSprint, acceptPreparedSprint, sprintTestClock } from "./fixtures/sprint-start";

function prepared(count = 1) {
  const state = setup();
  const issue = core.createIssue(state.me, { workspaceId: state.ws.id, title: "担当する仕事" });
  const issues = [issue, ...Array.from({ length: count - 1 }, () => core.createIssue(state.me, { workspaceId: state.ws.id, title: "次の仕事" }))];
  const proposal = prepareSprint(state.me, state.ws.key, issues.map(i => i.id));
  const ready = acceptPreparedSprint(state.me, proposal);
  const sprint = core.activateSprint(state.me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  return { ...state, issue, sprint, itemId: proposal.items[0]!.id, items: proposal.items, proposal };
}

function authority() {
  return { runId: "元Run", caller: "監督A", coordinator: "監督A", consumerGeneration: 7,
    runtimeId: "home-runtime", source: "OrcaのRunとcaller", observedAt: sprintTestClock.now.toISOString() };
}

function receipt(requestId: string, taskId: string, dispatchId: string | null = null): core.SprintExecutionReceipt {
  return { runId: "元Run", requestId, taskId, dispatchId, requested: null, effective: null, identity: null,
    source: "Orcaの操作応答", receivedAt: sprintTestClock.now.toISOString() };
}

async function reserved(count = 1) {
  const state = prepared(count);
  const adapter = { authority: async () => authority() };
  const session = await core.beginSprintSession(state.llm, state.sprint.id, { expectedVersion: state.sprint.version, requestKey: "監督登録", runId: "元Run" }, adapter, sprintTestClock);
  const input = { sessionId: session.id, generation: 1, requestKey: "主担当", itemId: state.itemId,
    actor: state.llm.actor, spec: "合意した仕事を行う", placement: { worktree: "path:/専用作業場所", agent: "codex" } };
  const attempt = core.prepareSprintExecution(state.llm, state.sprint.id, input, sprintTestClock);
  return { ...state, session, attempt, input, adapter };
}

test("同じ予約要求は保存した主試行へ合流し、設定未観測では着手許可を閉じる", async () => {
  const { db, llm, sprint, itemId, issue } = prepared();
  const adapter = { authority: async () => authority() };
  const session = await core.beginSprintSession(llm, sprint.id, { expectedVersion: sprint.version, requestKey: "監督登録", runId: "元Run" }, adapter, sprintTestClock);
  const input = { sessionId: session.id, generation: 1, requestKey: "主担当", itemId,
    actor: llm.actor, spec: "合意した仕事を行う", placement: { worktree: "path:/専用作業場所", agent: "codex" } };
  const first = core.prepareSprintExecution(llm, sprint.id, input, sprintTestClock);
  const replay = core.prepareSprintExecution(llm, sprint.id, input, sprintTestClock);
  expect(replay.id).toBe(first.id);
  const state = core.getSprintExecutionState(db, sprint.id, sprintTestClock);
  expect(state).toMatchObject({ occupied: 1, reserved: 1, canStart: false, session: { generation: 1, consumerGeneration: 7 } });
  expect(state.attempts).toHaveLength(1);
  expect(state.operations).toHaveLength(1);
  expect(state.operations[0]).toMatchObject({ state: "prepared", requestId: null });
  expect(codeOf(() => core.prepareSprintExecution(llm, sprint.id, { ...input, requestKey: "別要求" }, sprintTestClock))).toBe("EXECUTION_OWNED");
  expect(codeOf(() => core.prepareSprintExecution(llm, sprint.id, { ...input, spec: "別の仕事" }, sprintTestClock))).toBe("IDEMPOTENCY_CONFLICT");
  expect(core.getIssue(db, issue.id).status).toBe("todo");
  db.close();
});

test("Task作成と起動の送信前に予約を保存し、応答喪失後も同じ操作とTaskへ合流する", async () => {
  const { db, llm, sprint, session, attempt, adapter } = await reserved();
  const sends: core.SprintExecutionOperation[] = [];
  const external: core.SprintOrcaAdapter = { ...adapter, send: async operation => {
    const visible = core.getSprintExecutionState(db, sprint.id, sprintTestClock);
    expect(visible.operations.find(o => o.id === operation.id)?.state).toBe("sending");
    sends.push(operation);
    if (operation.kind === "worker_start") throw new Error("起動応答を失った");
    return receipt("実Task要求", "実Task");
  } };
  let state = await core.requestSprintExecution(llm, sprint.id, { sessionId: session.id, generation: 1, attemptId: attempt.id }, external, sprintTestClock);
  expect(sends.map(o => o.kind)).toEqual(["task_create", "worker_start"]);
  expect(state.operations[0]).toMatchObject({ state: "confirmed", requestId: "実Task要求" });
  expect(state.operations[1]).toMatchObject({ state: "unknown", requestId: null });
  expect(state.attempts[0]).toMatchObject({ taskId: "実Task", dispatchId: null, phase: "unknown", occupied: true });
  const ids = state.operations.map(o => o.id);
  state = await core.requestSprintExecution(llm, sprint.id, { sessionId: session.id, generation: 1, attemptId: attempt.id }, external, sprintTestClock);
  expect(sends).toHaveLength(2);
  expect(state.operations.map(o => o.id)).toEqual(ids);
  expect(state).toMatchObject({ occupied: 1, reserved: 1, canStart: false });
  db.close();
});

test("別callerのabsentとpendingは予約を保持し、completedは既知requestの元Dispatchへ送信せず合流する", async () => {
  const { db, llm, sprint, session, attempt, adapter } = await reserved();
  const sends: string[] = [];
  const external: core.SprintOrcaAdapter = { ...adapter,
    send: async operation => { sends.push(operation.id); return operation.kind === "task_create" ? receipt("Task要求", "元Task") : receipt("起動要求", "元Task"); },
    inventory: async () => ({ tasks: [], workers: [], complete: true }),
    request: async requestId => ({ state: "absent", requestId, receipt: null, source: "別callerの照会", observedAt: sprintTestClock.now.toISOString() }),
  };
  await core.requestSprintExecution(llm, sprint.id, { sessionId: session.id, generation: 1, attemptId: attempt.id }, external, sprintTestClock);
  external.authority = async () => ({ ...authority(), caller: "監督B", coordinator: "監督B", consumerGeneration: 8 });
  const context = { sessionId: session.id, generation: 1 };
  let state = await core.reconcileSprintExecution(llm, sprint.id, context, external, sprintTestClock);
  expect(state.operations[1]).toMatchObject({ requestId: "起動要求", state: "unknown", reason: { code: "REQUEST_ABSENT" } });
  expect(state.occupied).toBe(1);
  external.request = async requestId => ({ state: "pending", requestId, receipt: null, source: "元要求の照会", observedAt: sprintTestClock.now.toISOString() });
  state = await core.reconcileSprintExecution(llm, sprint.id, context, external, sprintTestClock);
  expect(state.operations[1]?.reason?.code).toBe("REQUEST_PENDING");
  external.request = async requestId => ({ state: "completed", requestId, receipt: receipt(requestId, "元Task", "元Dispatch"), source: "元要求の照会", observedAt: sprintTestClock.now.toISOString() });
  state = await core.reconcileSprintExecution(llm, sprint.id, context, external, sprintTestClock);
  expect(state.attempts[0]).toMatchObject({ id: attempt.id, taskId: "元Task", dispatchId: "元Dispatch", canStart: false });
  expect(state.operations[1]).toMatchObject({ requestId: "起動要求", state: "confirmed" });
  expect(sends).toHaveLength(2);
  db.close();
});

test("交代intentが旧監督をfenceし、実行版が変わったsnapshotのCASを拒否して正当な担当は保持する", async () => {
  const { db, llm, sprint, session, attempt, input, adapter } = await reserved();
  const context = { sessionId: session.id, generation: 1 };
  const next: core.SprintOrcaAdapter = { authority: async () => ({ ...authority(), caller: "監督B", coordinator: "監督B", consumerGeneration: 8 }),
    inventory: async () => ({ tasks: [], workers: [], complete: true }) };
  core.beginSprintHandover(llm, sprint.id, { ...context, requestKey: "引継ぎ" });
  expect(codeOf(() => core.prepareSprintExecution(llm, sprint.id, { ...input, requestKey: "旧世代" }, sprintTestClock))).toBe("HANDOVER_PENDING");
  const snapshot = await core.observeSprintSession(llm, sprint.id, context, next, sprintTestClock);
  const changed = receipt("遅い要求", "遅いTask");
  core.recordSprintExecutionReceipt(llm, sprint.id, { ...context, operationId: core.getSprintExecutionState(db, sprint.id).operations[0]!.id, receipt: changed }, sprintTestClock);
  expect(codeOf(() => core.completeSprintHandover(llm, sprint.id, { ...context, snapshotId: snapshot.id }, sprintTestClock))).toBe("RECONCILE_REQUIRED");
  expect(core.getSprintExecutionState(db, sprint.id).quarantined).toHaveLength(1);
  // 別の予約だけを持つSprintで、CAS先行時の旧世代送信を公開操作から確認する。
  const other = await reserved();
  const old = { sessionId: other.session.id, generation: 1 };
  core.beginSprintHandover(other.llm, other.sprint.id, { ...old, requestKey: "引継ぎ" });
  const observed = await core.observeSprintSession(other.llm, other.sprint.id, old, next, sprintTestClock);
  const resumed = core.completeSprintHandover(other.llm, other.sprint.id, { ...old, snapshotId: observed.id }, sprintTestClock);
  expect(resumed.session).toMatchObject({ generation: 2, caller: "監督B", consumerGeneration: 8, state: "active" });
  expect(resumed.attempts[0]?.id).toBe(other.attempt.id);
  let sends = 0;
  await expect(core.requestSprintExecution(other.llm, other.sprint.id, { ...old, attemptId: other.attempt.id }, { ...adapter, send: async () => { sends++; return changed; } }, sprintTestClock)).rejects.toMatchObject({ code: "STALE_GENERATION" });
  expect(sends).toBe(0);
  expect(attempt.occupied).toBe(true);
  db.close(); other.db.close();
});

test("Orca adapterは初回にretry要求を作らず、実receiptだけを保存しremote一覧の全ページを照合する", async () => {
  const state = prepared();
  const commands: string[][] = [];
  const runner: core.OrcaRunner = async args => {
    commands.push(args);
    let result: unknown;
    if (args[0] === "status") result = { runtime: { runtimeId: "home-runtime" }, caller: { orcaSessionId: "実caller" } };
    else if (args[1] === "run-show" || args[1] === "run-current") result = { run: { id: "元Run", coordinator_handle: "監督A", consumer_generation: 7 } };
    else if (args[1] === "task-create") result = { task: { id: "実Task", run_id: "元Run" }, mutation: { requestId: "実Task要求" } };
    else if (args[1] === "worker-start") result = { runId: "元Run", taskId: "実Task", dispatchId: "実Dispatch", mutation: { requestId: "実起動要求" },
      launch: { requested: { agent: "codex", model: "設定値", effort: "high" }, effective: { agent: "codex", model: "設定値", effort: "high" } } };
    else if (args[1] === "task-list") result = { runId: "元Run", tasks: args.includes("--cursor") ? [{ id: "実Task", run_id: "元Run", spec: "既知Task", parent_task_id: null }] : [],
      page: args.includes("--cursor") ? { hasMore: false, nextCursor: null } : { hasMore: true, nextCursor: "次Task" } };
    else if (args[1] === "worker-list") result = { workers: args.includes("--cursor") ? [{ runId: "元Run", taskId: "実Task", dispatchId: "実Dispatch",
      projection: { liveness: { verdict: "live", observedAt: sprintTestClock.now.getTime() } },
      identity: { runtimeId: "実行runtime", incarnationId: "実incarnation", terminal: "実端末", remoteRuntimeEpoch: "実epoch" } }] : [],
      page: args.includes("--cursor") ? { hasMore: false, nextCursor: null } : { hasMore: true, nextCursor: "次worker" } };
    else throw new Error(`想定外の操作:${args[1]}`);
    return { kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result, _meta: { runtimeId: "home-runtime" } }), stderr: "" };
  };
  const adapter = core.createSprintOrcaAdapter(runner, { from: "監督A", clock: sprintTestClock });
  const session = await core.beginSprintSession(state.llm, state.sprint.id, { expectedVersion: state.sprint.version, requestKey: "監督", runId: "元Run" }, adapter, sprintTestClock);
  const attempt = core.prepareSprintExecution(state.llm, state.sprint.id, { sessionId: session.id, generation: 1, requestKey: "実行", itemId: state.itemId,
    actor: state.llm.actor, spec: "合意した仕事", placement: { on: "実行host", worktree: "path:/専用", agent: "codex", model: "設定値", effort: "high" } }, sprintTestClock);
  await core.requestSprintExecution(state.llm, state.sprint.id, { sessionId: session.id, generation: 1, attemptId: attempt.id }, adapter, sprintTestClock);
  const reconciled = await core.reconcileSprintExecution(state.llm, state.sprint.id, { sessionId: session.id, generation: 1 }, adapter, sprintTestClock);
  expect(reconciled.operations.map(o => o.requestId)).toEqual(["実Task要求", "実起動要求"]);
  expect(reconciled.attempts[0]).toMatchObject({ dispatchId: "実Dispatch", identity: { runtimeId: "実行runtime", incarnationId: "実incarnation" } });
  expect(commands.filter(a => a[1] === "task-create" || a[1] === "worker-start").every(a => !a.includes("--retry-request"))).toBe(true);
  expect(commands.filter(a => a[1] === "worker-list").every(a => a.includes("--include-remote") && a.includes("元Run"))).toBe(true);
  expect(commands.some(a => a.includes("次Task"))).toBe(true);
  expect(commands.some(a => a.includes("次worker"))).toBe(true);
  state.db.close();
});

test("中止後も未解決の予約を通常start・suggest・next・一般更新・一括更新から保護する", async () => {
  const { db, me, llm, ws, sprint, issue } = await reserved();
  core.cancelSprint(me, sprint.id, { expectedVersion: sprint.version, requestKey: "中止", reason: "次の判断を待つ" });
  expect(codeOf(() => core.startIssue(llm, issue.id))).toBe("SPRINT_CONTEXT_REQUIRED");
  expect(core.suggestIssue(llm, { workspaceId: ws.id })).toBeNull();
  expect(core.nextIssue(llm, { workspaceId: ws.id })).toBeNull();
  expect(codeOf(() => core.updateIssue(me, issue.id, { status: "in_progress" }))).toBe("SPRINT_CONTEXT_REQUIRED");
  expect(codeOf(() => core.bulkUpdateIssues(me, [issue.id], { status: "in_progress" }))).toBe("BULK_UPDATE_FAILED");
  expect(core.getSprintExecutionState(db, sprint.id).occupied).toBe(1);
  expect(core.getIssue(db, issue.id).status).toBe("todo");
  db.close();
});

test("同じworkerのruntimeとincarnationの変化、古い観測を不明として枠を保持する", async () => {
  const state = await reserved();
  const context = { sessionId: state.session.id, generation: 1 };
  const original = { runtimeId: "実行runtime", incarnationId: "元incarnation", terminal: "端末", remoteRuntimeEpoch: "epoch" };
  const external: core.SprintOrcaAdapter = { ...state.adapter, send: async operation => ({ ...receipt(operation.kind === "task_create" ? "Task要求" : "起動要求", "元Task", operation.kind === "worker_start" ? "元Dispatch" : null), identity: original }) };
  await core.requestSprintExecution(state.llm, state.sprint.id, { ...context, attemptId: state.attempt.id }, external, sprintTestClock);
  for (const changed of [{ ...original, incarnationId: "別incarnation" }, { ...original, runtimeId: "別runtime" }]) {
    external.inventory = async () => ({ complete: true, tasks: [], workers: [{ runId: "元Run", taskId: "元Task", dispatchId: "元Dispatch", identity: changed,
      liveness: "live", source: "実行ホストの観測", observedAt: sprintTestClock.now.toISOString() }] });
    const observed = await core.reconcileSprintExecution(state.llm, state.sprint.id, context, external, sprintTestClock);
    expect(observed.attempts[0]).toMatchObject({ phase: "unknown", reason: { code: "IDENTITY_CHANGED" }, identity: original });
    expect(observed.occupied).toBe(1);
  }
  external.inventory = async () => ({ complete: true, tasks: [], workers: [{ runId: "元Run", taskId: "元Task", dispatchId: "元Dispatch", identity: original,
    liveness: "live", source: "古いホストの観測", observedAt: "2026-03-08T11:00:00.000Z" }] });
  const stale = await core.reconcileSprintExecution(state.llm, state.sprint.id, context, external, sprintTestClock);
  expect(stale.attempts[0]).toMatchObject({ phase: "unknown", reason: { code: "OBSERVATION_STALE" } });
  state.db.close();
});

test("pendingの再実行は肯定的な非稼働証拠とliteral回復手順がある同じ既知requestだけを使う", async () => {
  const state = await reserved();
  const context = { sessionId: state.session.id, generation: 1 };
  const sends: (string | undefined)[] = [];
  let evidence = false;
  const external: core.SprintOrcaAdapter = { ...state.adapter,
    send: async (operation, retryId) => { sends.push(retryId); return receipt(operation.kind === "task_create" ? "Task要求" : "起動要求", "元Task", retryId ? "元Dispatch" : null); },
    inventory: async () => ({ tasks: [], workers: [], complete: true }),
    request: async requestId => ({ state: "pending", requestId, receipt: null, source: "元要求の照会", observedAt: sprintTestClock.now.toISOString(),
      ...(evidence ? { recovery: { originalInactive: true as const, evidence: "元の要求processの終了を実行ホストで確認",
        argv: ["orca", "orchestration", "worker-start", "--task", "元Task", "--run", "元Run", "--worktree", "path:/専用作業場所", "--agent", "codex", "--from", "監督A", "--retry-request", "起動要求", "--json"] } } : {}) }),
  };
  let observed = await core.requestSprintExecution(state.llm, state.sprint.id, { ...context, attemptId: state.attempt.id }, external, sprintTestClock);
  const operationId = observed.operations[1]!.id;
  observed = await core.recoverSprintExecution(state.llm, state.sprint.id, { ...context, operationId }, external, sprintTestClock);
  expect(sends).toEqual([undefined, undefined]);
  expect(observed.operations[1]?.state).toBe("unknown");
  evidence = true;
  observed = await core.recoverSprintExecution(state.llm, state.sprint.id, { ...context, operationId }, external, sprintTestClock);
  expect(sends).toEqual([undefined, undefined, "起動要求"]);
  expect(observed.operations[1]).toMatchObject({ id: operationId, requestId: "起動要求", state: "confirmed" });
  expect(observed.attempts[0]?.dispatchId).toBe("元Dispatch");
  state.db.close();
});

test("別DB接続でsendingが交代CASより先なら遅い結果を隔離し、同じ予約と操作を保持する", async () => {
  const state = await reserved();
  const second = core.openDb(state.db.filename);
  const newCtx = { db: second, actor: state.llm.actor };
  const context = { sessionId: state.session.id, generation: 1 };
  let sent!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => sent = resolve);
  const gate = new Promise<void>(resolve => release = resolve);
  const external: core.SprintOrcaAdapter = { ...state.adapter, send: async () => { sent(); await gate; return receipt("遅いTask要求", "元Task"); } };
  const sending = core.requestSprintExecution(state.llm, state.sprint.id, { ...context, attemptId: state.attempt.id }, external, sprintTestClock);
  await entered;
  expect(core.getSprintExecutionState(second, state.sprint.id).operations[0]?.state).toBe("sending");
  core.beginSprintHandover(newCtx, state.sprint.id, { ...context, requestKey: "引継ぎ" });
  const next = { authority: async () => ({ ...authority(), caller: "監督B", coordinator: "監督B", consumerGeneration: 8 }), inventory: async () => ({ tasks: [], workers: [], complete: true }) };
  const observed = await core.observeSprintSession(newCtx, state.sprint.id, context, next, sprintTestClock);
  expect(observed.resolved).toBe(false);
  release();
  await sending;
  expect(codeOf(() => core.completeSprintHandover(newCtx, state.sprint.id, { ...context, snapshotId: observed.id }, sprintTestClock))).toBe("RECONCILE_REQUIRED");
  const result = core.getSprintExecutionState(second, state.sprint.id);
  expect(result).toMatchObject({ occupied: 1, session: { generation: 1, state: "handover" } });
  expect(result.quarantined[0]?.receipt.requestId).toBe("遅いTask要求");
  expect(result.attempts[0]?.id).toBe(state.attempt.id);
  expect(result.operations).toHaveLength(1);
  second.close(); state.db.close();
});

test("別DB接続で交代CASがsendingより先なら外部送信せず旧世代を拒否する", async () => {
  const state = await reserved();
  const second = core.openDb(state.db.filename), nextCtx = { db: second, actor: state.llm.actor };
  const context = { sessionId: state.session.id, generation: 1 };
  let entered!: () => void, release!: () => void, sends = 0;
  const waiting = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
  const sending = core.requestSprintExecution(state.llm, state.sprint.id, { ...context, attemptId: state.attempt.id }, {
    authority: async () => { entered(); await gate; return authority(); }, send: async () => { sends++; return receipt("架空要求", "架空Task"); },
  }, sprintTestClock);
  await waiting;
  const next = { authority: async () => ({ ...authority(), caller: "監督B", coordinator: "監督B", consumerGeneration: 8 }), inventory: async () => ({ tasks: [], workers: [], complete: true }) };
  const resumed = await core.resumeSprintSession(nextCtx, state.sprint.id, { ...context, requestKey: "引継ぎ" }, next, sprintTestClock);
  expect(resumed.state.session?.generation).toBe(2);
  release();
  await expect(sending).rejects.toMatchObject({ code: "STALE_GENERATION" });
  expect(sends).toBe(0);
  expect(core.getSprintExecutionState(second, state.sprint.id).operations[0]).toMatchObject({ state: "prepared", generation: 2, requestId: null });
  second.close(); state.db.close();
});

test("実公開JSON形のparent_idとcompleted receiptを読み、欠けたspecとhost identityを補完しない", async () => {
  const adapter = core.createSprintOrcaAdapter(async args => {
    const result = args[1] === "task-list" ? { runId: "元Run", legacyReadOnly: false, count: 47,
      tasks: [{ id: "元Task", run_id: "元Run", parent_id: "親Task", dispatch_id: "元Dispatch", status: "dispatched" }] }
      : args[1] === "worker-list" ? { workers: [{ dispatchId: "元Dispatch", taskId: "元Task", runId: "元Run", workerState: "ready", agentTerminalHandle: "実端末",
        projection: { liveness: { verdict: "live", observedAt: sprintTestClock.now.getTime(), source: "execution_host" }, resource: { state: "absent", reason: "not_materialized" } } }],
        counts: { retained: 20 }, page: { limit: 100, total: 54, hasMore: false, nextCursor: null }, scope: { run: "元Run", source: "flag" } }
      : { requestId: "実要求", state: "completed", method: "orchestration.workerStart", receipt: { runId: "元Run", taskId: "元Task", dispatchId: "元Dispatch", state: "ready",
        launch: { requested: { agent: "codex", model: "実モデル", effort: "high" }, effective: null }, mutation: { requestId: "実要求", replayed: false } } };
    return { kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result, _meta: { runtimeId: "home-runtime" } }), stderr: "" };
  }, { from: "監督A", clock: sprintTestClock });
  const inventory = await adapter.inventory!("元Run");
  expect(inventory.tasks).toEqual([{ runId: "元Run", taskId: "元Task", parentTaskId: "親Task", spec: null }]);
  expect(inventory.workers[0]).toMatchObject({ identity: { terminal: "実端末", runtimeId: null, incarnationId: null, remoteRuntimeEpoch: null }, liveness: "live" });
  expect(await adapter.request!("実要求")).toMatchObject({ state: "completed", requestId: "実要求", receipt: { taskId: "元Task", dispatchId: "元Dispatch", effective: null } });
});

test("runtime変更直後は不明を保持し、元要求と同Task・Dispatchの肯定的な再照合後に新runtimeで監督を再開する", async () => {
  const state = await reserved(), context = { sessionId: state.session.id, generation: 1 };
  const original = { runtimeId: "旧host", incarnationId: "旧incarnation", terminal: "端末", remoteRuntimeEpoch: "旧epoch" };
  await core.requestSprintExecution(state.llm, state.sprint.id, { ...context, attemptId: state.attempt.id }, {
    ...state.adapter, send: async operation => ({ ...receipt(operation.kind === "task_create" ? "Task要求" : "起動要求", "元Task", operation.kind === "worker_start" ? "元Dispatch" : null), identity: original }),
  }, sprintTestClock);
  const updated = { runtimeId: "新host", incarnationId: "新incarnation", terminal: "端末", remoteRuntimeEpoch: "新epoch" };
  const next: core.SprintOrcaAdapter = {
    authority: async () => ({ ...authority(), runtimeId: "新home", caller: "監督B", coordinator: "監督B", consumerGeneration: 8 }),
    inventory: async () => ({ complete: true, tasks: [{ runId: "元Run", taskId: "元Task", spec: null, parentTaskId: null }],
      workers: [{ runId: "元Run", taskId: "元Task", dispatchId: "元Dispatch", identity: updated, liveness: "live", source: "新ホストの実行観測", observedAt: sprintTestClock.now.toISOString() }] }),
    request: async requestId => ({ requestId, state: "completed", receipt: receipt(requestId, "元Task", requestId === "起動要求" ? "元Dispatch" : null), source: "同じ永続要求の照会", observedAt: sprintTestClock.now.toISOString() }),
  };
  const unknown = await core.reconcileSprintExecution(state.llm, state.sprint.id, context, next, sprintTestClock);
  expect(unknown).toMatchObject({ occupied: 1, session: { runtimeId: "home-runtime", generation: 1 } });
  expect(unknown.attempts[0]).toMatchObject({ phase: "unknown", reason: { code: "RUNTIME_CHANGED" }, identity: original });
  const resumed = await core.resumeSprintSession(state.llm, state.sprint.id, { ...context, requestKey: "再接続" }, next, sprintTestClock);
  expect(resumed.state.session).toMatchObject({ runtimeId: "新home", generation: 2, caller: "監督B", consumerGeneration: 8 });
  expect(resumed.state.attempts[0]).toMatchObject({ id: state.attempt.id, taskId: "元Task", dispatchId: "元Dispatch", identity: updated, canStart: false });
  expect(resumed.state.operations.map(o => o.requestId)).toEqual(["Task要求", "起動要求"]);
  expect(core.getSprintWorkerContext(state.db, state.sprint.id, { fromHandle: "dispatch:元Dispatch", runId: "元Run", taskId: "元Task", dispatchId: "元Dispatch" })).toMatchObject({ generation: 2, canStart: false });
  state.db.close();
});

test("正当なTask分割とレビュー補助は親の主試行に属し、unknown中の主試行は並行枠を使い続ける", async () => {
  const state = await reserved(2), context = { sessionId: state.session.id, generation: 1 };
  await core.requestSprintExecution(state.llm, state.sprint.id, { ...context, attemptId: state.attempt.id }, {
    ...state.adapter, send: async operation => { if (operation.kind === "worker_start") throw new Error("応答喪失"); return receipt("Task要求", "主Task"); },
  }, sprintTestClock);
  const helper = core.prepareSprintExecution(state.llm, state.sprint.id, { ...state.input, requestKey: "レビュー補助", actor: "レビュー担当", parentAttemptId: state.attempt.id }, sprintTestClock);
  expect(helper).toMatchObject({ parentAttemptId: state.attempt.id, actor: "レビュー担当" });
  const result = core.getSprintExecutionState(state.db, state.sprint.id);
  expect(result).toMatchObject({ occupied: 1, reserved: 1 }); expect(result.attempts).toHaveLength(2);
  expect(result.operations.find(o => o.attemptId === helper.id)?.input.parentTaskId).toBe("主Task");
  expect(codeOf(() => core.prepareSprintExecution(state.llm, state.sprint.id, { ...state.input, requestKey: "別Issue", itemId: state.items[1]!.id }, sprintTestClock))).toBe("PARALLEL_LIMIT");
  state.db.close();
});

test("予約と送信の直前に期限・合意・既存着手を再検査し、自己申告flagでは迂回できない", async () => {
  const state = await reserved();
  const expired = { now: new Date("2026-03-09T04:00:00.000Z") };
  expect(codeOf(() => core.prepareSprintExecution(state.llm, state.sprint.id, { ...state.input, requestKey: "期限後" }, expired))).toBe("SPRINT_EXPIRED");
  let sends = 0;
  await expect(core.requestSprintExecution(state.llm, state.sprint.id, { sessionId: state.session.id, generation: 1, attemptId: state.attempt.id }, {
    authority: async () => ({ ...authority(), observedAt: expired.now.toISOString() }), send: async () => { sends++; return receipt("要求", "Task"); },
  }, expired)).rejects.toMatchObject({ code: "SPRINT_EXPIRED" });
  expect(sends).toBe(0);
  expect(codeOf(() => core.prepareSprintExecution(state.llm, state.sprint.id, { ...state.input, allowStart: true } as any, sprintTestClock))).toBe("INVALID_ARGS");
  const revised = core.proposeSprintPlan(state.me, state.sprint.id, { ...state.proposal.input, expectedVersion: state.sprint.version, requestKey: "計画変更", goal: "変えたゴール" });
  core.acceptSprintPlan(state.me, state.sprint.id, revised.plan.id, { expectedVersion: revised.sprint.version, requestKey: "変更合意", contentHash: revised.plan.contentHash });
  await expect(core.requestSprintExecution(state.llm, state.sprint.id, { sessionId: state.session.id, generation: 1, attemptId: state.attempt.id }, state.adapter, sprintTestClock)).rejects.toMatchObject({ code: "TARGET_CHANGED" });
  const ordinary = setup(), issue = core.createIssue(ordinary.me, { workspaceId: ordinary.ws.id, title: "通常経路で進行中" });
  core.startIssue(ordinary.llm, issue.id);
  const proposal = prepareSprint(ordinary.me, ordinary.ws.key, [issue.id]), ready = acceptPreparedSprint(ordinary.me, proposal);
  const active = core.activateSprint(ordinary.me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  const session = await core.beginSprintSession(ordinary.llm, active.id, { expectedVersion: active.version, requestKey: "監督", runId: "元Run" }, state.adapter, sprintTestClock);
  expect(codeOf(() => core.prepareSprintExecution(ordinary.llm, active.id, { ...state.input, sessionId: session.id, itemId: proposal.items[0]!.id }, sprintTestClock))).toBe("EXECUTION_OWNED");
  ordinary.db.close(); state.db.close();
});

test("公開worker-showから正確な端末incarnationとremote epochを取得し、runtime IDや実効設定を合成しない", async () => {
  const adapter = core.createSprintOrcaAdapter(async args => {
    const result = args[1] === "task-list" ? { tasks: [{ id: "元Task", run_id: "元Run", spec: "正確なTask", parent_id: null }] }
      : args[1] === "worker-list" ? { workers: [{ runId: "元Run", taskId: "元Task", dispatchId: "元Dispatch", agentTerminalHandle: "実端末",
        projection: { liveness: { verdict: "live", observedAt: sprintTestClock.now.getTime() } } }], page: { hasMore: false, nextCursor: null } }
      : { dispatch: { id: "元Dispatch", runId: "元Run", taskId: "元Task", task_id: "元Task" },
        worker: { dispatchId: "元Dispatch", runtimeEpoch: "home-runtime", startOptions: { launch: { requested: { model: "要求モデル", effort: "high" }, effective: null } } },
        remoteRuntimeEpoch: "実host-epoch", terminal: { handle: "実端末", incarnationId: "実incarnation", worktreePath: "/専用", branch: "refs/heads/作業" },
        projection: { liveness: { verdict: "live", source: "execution_host", observedAt: sprintTestClock.now.getTime() } }, observation: { status: "live", exactWorker: true } };
    return { kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result, _meta: { runtimeId: "home-runtime" } }), stderr: "" };
  }, { from: "監督A", clock: sprintTestClock });
  const observed = await adapter.inventory!("元Run", [{ taskId: "元Task", dispatchId: "元Dispatch" }]);
  expect(observed.workers[0]).toMatchObject({ identity: { runtimeId: null, incarnationId: "実incarnation", terminal: "実端末", remoteRuntimeEpoch: "実host-epoch" }, liveness: "live" });
});

test("Task作成の応答を全て失っても実際の送信specと正確な既存対応へ合流し新Taskを作らない", async () => {
  const state = await reserved(), context = { sessionId: state.session.id, generation: 1 };
  let externalSpec = "", tasks = 0, starts = 0;
  const runner: core.OrcaRunner = async args => {
    let result: unknown;
    if (args[0] === "status") result = { runtime: { runtimeId: "home-runtime" }, caller: { orcaSessionId: "実caller" } };
    else if (["run-show", "run-current"].includes(args[1]!)) result = { run: { id: "元Run", coordinator_handle: "監督A", consumer_generation: 7 } };
    else if (args[1] === "task-create") { tasks++; externalSpec = args[args.indexOf("--spec") + 1]!; return { kind: "timeout" }; }
    else if (args[1] === "task-list") result = { tasks: [{ id: "既存Task", run_id: "元Run", parent_id: null, spec: externalSpec }] };
    else if (args[1] === "worker-list") result = { workers: [], page: { hasMore: false, nextCursor: null } };
    else if (args[1] === "worker-start") { starts++; result = { runId: "元Run", taskId: "既存Task", dispatchId: "既存Dispatch", mutation: { requestId: "実起動要求" } }; }
    else throw new Error("想定外の操作");
    return { kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  };
  const adapter = core.createSprintOrcaAdapter(runner, { from: "監督A", clock: sprintTestClock });
  const unknown = await core.requestSprintExecution(state.llm, state.sprint.id, { ...context, attemptId: state.attempt.id }, adapter, sprintTestClock);
  expect(unknown.operations[0]).toMatchObject({ requestId: null, state: "unknown" });
  const joined = await core.reconcileSprintExecution(state.llm, state.sprint.id, context, adapter, sprintTestClock);
  expect(joined.attempts[0]).toMatchObject({ id: state.attempt.id, taskId: "既存Task" });
  expect(joined.operations[0]?.id).toBe(unknown.operations[0]?.id);
  await core.requestSprintExecution(state.llm, state.sprint.id, { ...context, attemptId: state.attempt.id }, adapter, sprintTestClock);
  expect([tasks, starts]).toEqual([1, 1]);
  state.db.close();
});

test("receipt保存境界の中断後も同じ保存IDと予約を新DB接続から復元して元Taskへ合流する", async () => {
  const state = await reserved(), context = { sessionId: state.session.id, generation: 1 }, path = state.db.filename;
  let operation!: core.SprintExecutionOperation;
  await expect(core.requestSprintExecution(state.llm, state.sprint.id, { ...context, attemptId: state.attempt.id }, {
    ...state.adapter, send: async sent => { operation = sent; state.db.close(); return receipt("失われた要求", "元Task"); },
  }, sprintTestClock)).rejects.toBeDefined();
  const db = core.openDb(path), ctx = { db, actor: state.llm.actor };
  const saved = core.getSprintExecutionState(db, state.sprint.id);
  expect(saved.operations[0]).toMatchObject({ id: operation.id, state: "sending", requestId: null });
  expect(saved.attempts[0]?.id).toBe(state.attempt.id);
  const external: core.SprintOrcaAdapter = { ...state.adapter,
    inventory: async () => ({ complete: true, tasks: [{ runId: "元Run", taskId: "元Task", spec: core.sprintOrcaTaskSpec(operation), parentTaskId: null }], workers: [] }) };
  const result = await core.reconcileSprintExecution(ctx, state.sprint.id, context, external, sprintTestClock);
  expect(result.operations[0]).toMatchObject({ id: operation.id, state: "confirmed" });
  expect(result).toMatchObject({ occupied: 1, reserved: 1 });
  expect(result.attempts[0]).toMatchObject({ id: state.attempt.id, taskId: "元Task" });
  db.close();
});

test("監督交代後の同じ業務要求は新世代の権限で同じ予約へ合流する", async () => {
  const state = await reserved();
  const next: core.SprintOrcaAdapter = { authority: async () => ({ ...authority(), caller: "監督B", coordinator: "監督B", consumerGeneration: 8 }),
    inventory: async () => ({ complete: true, tasks: [], workers: [] }) };
  await core.resumeSprintSession(state.llm, state.sprint.id, { sessionId: state.session.id, generation: 1, requestKey: "引継ぎ" }, next, sprintTestClock);
  const joined = core.prepareSprintExecution(state.llm, state.sprint.id, { ...state.input, generation: 2 }, sprintTestClock);
  expect(joined.id).toBe(state.attempt.id);
  expect(core.getSprintExecutionState(state.db, state.sprint.id)).toMatchObject({ occupied: 1 });
  state.db.close();
});

test("completedの応答でも別Runへの対応を採用せず同じ予約と不明理由を残す", async () => {
  const state = await reserved(); let sends = 0;
  const result = await core.requestSprintExecution(state.llm, state.sprint.id, { sessionId: state.session.id, generation: 1, attemptId: state.attempt.id }, {
    ...state.adapter, send: async () => { sends++; return { ...receipt("実要求", "別Task"), runId: "別Run" }; },
  }, sprintTestClock);
  expect(sends).toBe(1);
  expect(result.attempts[0]).toMatchObject({ taskId: null, phase: "unknown" });
  expect(result.operations[0]).toMatchObject({ state: "unknown", requestId: "実要求", reason: { code: "RUN_MISMATCH" } });
  state.db.close();
});

test("request IDを取得できなかった試行も保存した正確なTask・Dispatchの再観測で新runtimeへ合流できる", async () => {
  const state = await reserved(), context = { sessionId: state.session.id, generation: 1 };
  await core.requestSprintExecution(state.llm, state.sprint.id, { ...context, attemptId: state.attempt.id }, { ...state.adapter,
    send: async operation => ({ ...receipt("未取得", "元Task", operation.kind === "worker_start" ? "元Dispatch" : null), requestId: null }),
  }, sprintTestClock);
  let sends = 0;
  const next: core.SprintOrcaAdapter = {
    authority: async () => ({ ...authority(), runtimeId: "新home", caller: "監督B", coordinator: "監督B", consumerGeneration: 8 }),
    inventory: async () => ({ complete: true, tasks: [{ runId: "元Run", taskId: "元Task", spec: null, parentTaskId: null }],
      workers: [{ runId: "元Run", taskId: "元Task", dispatchId: "元Dispatch", identity: { runtimeId: null, incarnationId: "実incarnation", terminal: "端末", remoteRuntimeEpoch: "実epoch" },
        liveness: "live", source: "正確な実行ホストの対応", observedAt: sprintTestClock.now.toISOString() }] }),
    send: async () => { sends++; throw new Error("再送してはいけない"); },
  };
  const resumed = await core.resumeSprintSession(state.llm, state.sprint.id, { ...context, requestKey: "同試行を引継ぐ" }, next, sprintTestClock);
  expect(resumed.state.session).toMatchObject({ generation: 2, runtimeId: "新home" });
  expect(resumed.state.attempts[0]).toMatchObject({ id: state.attempt.id, taskId: "元Task", dispatchId: "元Dispatch", canStart: false });
  expect(sends).toBe(0);
  state.db.close();
});

test("予約は採用中の合意と既存の回答済み判断への参照を保持する", async () => {
  const state = prepared();
  const question = core.askQuestion(state.llm, state.issue.id, "開始の前提を確認してください").question;
  core.answerQuestion(state.me, state.issue.id, "この版の要求で進める");
  const session = await core.beginSprintSession(state.llm, state.sprint.id, { expectedVersion: state.sprint.version, requestKey: "監督", runId: "元Run" }, { authority: async () => authority() }, sprintTestClock);
  const attempt = core.prepareSprintExecution(state.llm, state.sprint.id, { sessionId: session.id, generation: 1, itemId: state.itemId,
    requestKey: "担当", actor: state.llm.actor, spec: "合意した仕事", placement: { agent: "codex", worktree: "path:/専用" } }, sprintTestClock);
  expect(attempt).toMatchObject({ planId: state.proposal.plan.id, planHash: state.proposal.plan.contentHash });
  expect(attempt.decisionRefs).toContain(`question:${question.id}`);
  state.db.close();
});

test("未解決の予約を計画から外す合意では占有を消さず元の採用計画を保つ", async () => {
  const state = await reserved(2);
  const proposed = core.proposeSprintPlan(state.me, state.sprint.id, { ...state.proposal.input,
    expectedVersion: state.sprint.version, requestKey: "未解決を除外", items: [state.proposal.input.items[1]!] });
  expect(codeOf(() => core.acceptSprintPlan(state.me, state.sprint.id, proposed.plan.id, { expectedVersion: proposed.sprint.version,
    requestKey: "除外合意", contentHash: proposed.plan.contentHash }))).toBe("EXECUTION_OWNED");
  expect(core.getSprint(state.db, state.sprint.id).adoptedPlanId).toBe(state.proposal.plan.id);
  expect(core.getSprintExecutionState(state.db, state.sprint.id).occupied).toBe(1);
  state.db.close();
});

test("同じ端末でもcaller identityが変わった監督から新規送信せず保存したcallerを維持する", async () => {
  const state = prepared();
  const external: core.SprintOrcaAdapter = { authority: async () => ({ ...authority(), callerIdentity: "元caller" }) };
  const session = await core.beginSprintSession(state.llm, state.sprint.id, { expectedVersion: state.sprint.version, requestKey: "監督", runId: "元Run" }, external, sprintTestClock);
  const attempt = core.prepareSprintExecution(state.llm, state.sprint.id, { sessionId: session.id, generation: 1, requestKey: "担当", itemId: state.itemId,
    actor: state.llm.actor, spec: "合意した仕事", placement: { agent: "codex", worktree: "path:/専用" } }, sprintTestClock);
  external.authority = async () => ({ ...authority(), callerIdentity: "別caller" });
  await expect(core.requestSprintExecution(state.llm, state.sprint.id, { sessionId: session.id, generation: 1, attemptId: attempt.id }, external, sprintTestClock)).rejects.toMatchObject({ code: "AUTHORITY_CHANGED" });
  expect(core.getSprintExecutionState(state.db, state.sprint.id).operations[0]).toMatchObject({ state: "prepared", callerIdentity: "元caller" });
  state.db.close();
});

test("合意前の通常着手を未照合の占有として保持し、別採択Issueの予約で並行上限を越えない", async () => {
  const state = setup();
  const a = core.createIssue(state.me, { workspaceId: state.ws.id, title: "先に通常着手した仕事" });
  const b = core.createIssue(state.me, { workspaceId: state.ws.id, title: "次に予約する仕事" });
  core.startIssue(state.llm, a.id);
  const proposal = prepareSprint(state.me, state.ws.key, [a.id, b.id]);
  const ready = acceptPreparedSprint(state.me, proposal);
  const sprint = core.activateSprint(state.me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  const session = await core.beginSprintSession(state.llm, sprint.id, { expectedVersion: sprint.version, requestKey: "監督", runId: "元Run" }, { authority: async () => authority() }, sprintTestClock);
  expect(core.getSprintExecutionState(state.db, sprint.id, sprintTestClock)).toMatchObject({ occupied: 1, reserved: 0,
    unreconciledOwnership: [{ itemId: proposal.items[0]!.id, sourceIssueKey: a.id, assignee: state.llm.actor, status: "in_progress" }] });
  expect(codeOf(() => core.prepareSprintExecution(state.llm, sprint.id, { sessionId: session.id, generation: 1, requestKey: "B予約", itemId: proposal.items[1]!.id,
    actor: state.llm.actor, spec: "別の仕事を開始する", placement: { agent: "codex", worktree: "path:/専用" } }, sprintTestClock))).toBe("PARALLEL_LIMIT");
  const observed = await core.reconcileSprintExecution(state.llm, sprint.id, { sessionId: session.id, generation: 1 }, {
    authority: async () => authority(), inventory: async () => ({ complete: true, tasks: [], workers: [] }),
  }, sprintTestClock);
  expect(observed).toMatchObject({ occupied: 1, reserved: 0, attempts: [], operations: [] });
  expect(core.getIssue(state.db, a.id)).toMatchObject({ status: "in_progress", assignee: state.llm.actor });
  state.db.close();
});

test("同itemの正式な新合意へ肯定的に照合し、同じ試行と操作を保って新世代で再開する", async () => {
  const state = await reserved(), before = core.getSprintExecutionState(state.db, state.sprint.id, sprintTestClock);
  const proposed = core.proposeSprintPlan(state.me, state.sprint.id, { ...state.proposal.input, expectedVersion: state.sprint.version,
    requestKey: "新しいゴール", goal: "人が選んだ新しいゴール", changeReason: "人の正式な変更" });
  core.acceptSprintPlan(state.me, state.sprint.id, proposed.plan.id, { expectedVersion: proposed.sprint.version, requestKey: "新合意", contentHash: proposed.plan.contentHash });
  const adapter: core.SprintOrcaAdapter = { ...state.adapter, inventory: async () => ({ complete: true, tasks: [], workers: [] }) };
  const context = { sessionId: state.session.id, generation: 1 };
  const observed = await core.observeSprintSession(state.llm, state.sprint.id, context, adapter, sprintTestClock);
  expect(observed).toMatchObject({ resolved: true, reason: null, planId: proposed.plan.id, planHash: proposed.plan.contentHash });
  const result = await core.resumeSprintSession(state.llm, state.sprint.id, { ...context, requestKey: "新合意へ引継ぐ" }, adapter, sprintTestClock);
  expect(result.state.session).toMatchObject({ generation: 2, planId: proposed.plan.id, planHash: proposed.plan.contentHash, state: "active" });
  expect(result.state.attempts[0]).toMatchObject({ id: state.attempt.id, planId: proposed.plan.id, planHash: proposed.plan.contentHash, canStart: false });
  expect(result.state.attempts[0]?.planHistory).toContainEqual({ planId: state.proposal.plan.id, planHash: state.proposal.plan.contentHash, reconciledAt: sprintTestClock.now.toISOString() });
  expect(result.state.operations.map(o => [o.id, o.inputHash, o.requestId])).toEqual(before.operations.map(o => [o.id, o.inputHash, o.requestId]));
  expect(result.state).toMatchObject({ occupied: 1, reserved: 1, canStart: false });
  expect(core.getIssue(state.db, state.issue.id).status).toBe("todo");
  state.db.close();
});

test("通常経路の実行場所を占有として保存し、中止やIssue表示の変更だけでは通常着手へ解放しない", async () => {
  const state = setup();
  const a = core.createIssue(state.me, { workspaceId: state.ws.id, title: "実行場所がある仕事" });
  core.startIssue({ db: state.db, actor: "元の担当" }, a.id, { location: { worktree: "/既存の作業場所", branch: "既存branch" } });
  core.updateIssue(state.me, a.id, { status: "todo" });
  const proposal = prepareSprint(state.me, state.ws.key, [a.id]), ready = acceptPreparedSprint(state.me, proposal);
  const sprint = core.activateSprint(state.me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  await core.beginSprintSession(state.llm, sprint.id, { expectedVersion: sprint.version, requestKey: "監督", runId: "元Run" }, { authority: async () => authority() }, sprintTestClock);
  const before = core.getSprintExecutionState(state.db, sprint.id, sprintTestClock);
  expect(before).toMatchObject({ occupied: 1, reserved: 0, unreconciledOwnership: [{ sourceIssueKey: a.id, assignee: "元の担当", worktree: "/既存の作業場所" }] });
  core.cancelSprint(state.me, sprint.id, { expectedVersion: sprint.version, requestKey: "中止", reason: "元担当を確認する" });
  expect(codeOf(() => core.startIssue(state.llm, a.id))).toBe("SPRINT_CONTEXT_REQUIRED");
  core.updateIssue(state.me, a.id, { status: "done", assignee: null });
  expect(core.getSprintExecutionState(state.db, sprint.id, sprintTestClock)).toMatchObject({ occupied: 1, reserved: 0, unreconciledOwnership: before.unreconciledOwnership });
  state.db.close();
});

test("新合意の設定が元の要求と異なる場合は同試行と旧要求を保持して開始と世代交代を閉じる", async () => {
  const state = await reserved(), context = { sessionId: state.session.id, generation: 1 };
  const proposed = core.proposeSprintPlan(state.me, state.sprint.id, { ...state.proposal.input, expectedVersion: state.sprint.version,
    requestKey: "設定変更", constraints: { ...state.proposal.input.constraints, model: "新モデル", effort: "high" }, changeReason: "人の設定変更" });
  core.acceptSprintPlan(state.me, state.sprint.id, proposed.plan.id, { expectedVersion: proposed.sprint.version, requestKey: "新設定合意", contentHash: proposed.plan.contentHash });
  const adapter: core.SprintOrcaAdapter = { ...state.adapter, inventory: async () => ({ complete: true, tasks: [], workers: [] }) };
  const result = await core.resumeSprintSession(state.llm, state.sprint.id, { ...context, requestKey: "設定を照合" }, adapter, sprintTestClock);
  expect(result.snapshot).toMatchObject({ resolved: false, reason: { code: "EXECUTION_SETTINGS_CHANGED" } });
  expect(result.state).toMatchObject({ occupied: 1, reserved: 1, canStart: false, session: { generation: 1, state: "handover", planId: state.session.planId } });
  expect(result.state.attempts[0]).toMatchObject({ id: state.attempt.id, planId: state.attempt.planId, placement: state.input.placement });
  await expect(core.requestSprintExecution(state.llm, state.sprint.id, { ...context, attemptId: state.attempt.id }, adapter, sprintTestClock)).rejects.toMatchObject({ code: "HANDOVER_PENDING" });
  state.db.close();
});

test("新合意を照合した後でも世代交代CAS時に期限を越えれば所有と予約を保って拒否する", async () => {
  const state = await reserved(), context = { sessionId: state.session.id, generation: 1 };
  const proposed = core.proposeSprintPlan(state.me, state.sprint.id, { ...state.proposal.input, expectedVersion: state.sprint.version,
    requestKey: "ゴール変更", goal: "新しいゴール", changeReason: "人の正式な変更" });
  core.acceptSprintPlan(state.me, state.sprint.id, proposed.plan.id, { expectedVersion: proposed.sprint.version, requestKey: "新合意", contentHash: proposed.plan.contentHash });
  core.beginSprintHandover(state.llm, state.sprint.id, { ...context, requestKey: "引継ぎ" });
  const nearEnd = { now: new Date("2026-03-09T03:59:59.000Z") };
  const adapter: core.SprintOrcaAdapter = { authority: async () => ({ ...authority(), observedAt: nearEnd.now.toISOString() }), inventory: async () => ({ complete: true, tasks: [], workers: [] }) };
  const snapshot = await core.observeSprintSession(state.llm, state.sprint.id, context, adapter, nearEnd);
  expect(snapshot.resolved).toBe(true);
  expect(codeOf(() => core.completeSprintHandover(state.llm, state.sprint.id, { ...context, snapshotId: snapshot.id }, { now: new Date("2026-03-09T04:00:00.000Z") }))).toBe("SPRINT_EXPIRED");
  expect(core.getSprintExecutionState(state.db, state.sprint.id)).toMatchObject({ occupied: 1, reserved: 1, session: { generation: 1, state: "handover", planId: state.session.planId } });
  state.db.close();
});

test("保存状態の再照合手順は現在のactor・監督・JSONを一回のshell入力へ結び、時計と上限を返す", async () => {
  const state = prepared();
  const caller = "監督 ' $(触らない)";
  const session = await core.beginSprintSession({ ...state.llm, actor: "codex" }, state.sprint.id,
    { expectedVersion: state.sprint.version, requestKey: "監督", runId: "元Run" },
    { authority: async () => ({ ...authority(), caller, coordinator: caller }) }, sprintTestClock);
  const read = core.getSprintExecutionState(state.db, state.sprint.id, sprintTestClock);
  expect(read).toMatchObject({ observedAt: "2026-03-08T12:00:00.000Z", maxParallel: 1 });
  const action = read.nextActions.find(a => a.argv.includes("reconcile"))!;
  expect(action.command).toContain("NOD_ACTOR='codex'");
  expect(action.command).toContain("'--from' '監督 '\"'\"' $(触らない)'");
  expect(action.input).toEqual({ sessionId: session.id, generation: 1 });
  expect(action.command).toContain(JSON.stringify(action.input));
  expect(action.command).toContain("'--input' '-'");
  const later = core.getSprintExecutionState(state.db, state.sprint.id, { now: new Date("2026-03-08T12:03:00.000Z") });
  expect(later.stale).toBe(true);
  expect(later.session?.observedAt).toBe("2026-03-08T12:00:00.000Z");
  state.db.close();
});
