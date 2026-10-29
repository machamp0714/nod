import { expect, test } from "bun:test";
import * as core from "../src/index";
import { setup } from "./helpers";
import { prepareSprint, acceptPreparedSprint, sprintTestClock as clock } from "./fixtures/sprint-start";

const terminal = "term_22222222-2222-4222-8222-222222222222";
const thread = "11111111-1111-4111-8111-111111111111";
const cwd = process.cwd();
const at = clock.now.toISOString();
function records() {
  const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: at, type, payload }) + "\n";
  return [
    line("session_meta", { id: thread, cwd, cli_version: "0.164.0", originator: "codex-tui", source: "cli", model_provider: "openai" }),
    line("event_msg", { type: "task_started", turn_id: "fixture-turn" }),
    line("turn_context", { turn_id: "fixture-turn", cwd, model: "gpt-6.1-sol", effort: "high" }),
    line("event_msg", { type: "thread_settings_applied", thread_id: thread, thread_settings: { cwd, model: "gpt-6.1-sol", reasoning_effort: "high", model_provider_id: "openai" } }),
    line("token_usage_record", { thread_id: thread, turn_id: "fixture-turn", session_id: thread, root_turn_id: "fixture-turn" }),
  ];
}
function fixture() {
  const commands: string[][] = [];
  const wire = {
    status: { runtime: { state: "ready", reachable: true, connectionState: "connected", runtimeId: "fixture-home", appVersion: "1.4.241" } } as Record<string, any>,
    run: { id: "fixture-run", coordinator_handle: terminal, consumer_generation: 7 },
    terminal: { handle: terminal, incarnationId: "fixture-incarnation", connected: true, worktreePath: cwd, agentIdentity: "codex" },
    lines: records(),
    afterCheck: () => {},
    beforeCommand: (_args: string[]) => {},
    spec: null as string | null,
    started: false,
    completed: false,
    failTaskCreate: false,
    messages: [] as Record<string, unknown>[],
  };
  const source: core.SprintSelfMetadataSource = { threadId: thread, terminal, cwd, collectorDigest: "a".repeat(64),
    snapshots: () => [{ filename: `rollout-${thread}.jsonl`, lines: wire.lines }] };
  const runner: core.OrcaRunner = async args => {
    commands.push(args);
    wire.beforeCommand(args);
    let result: unknown;
    if (args[0] === "status") result = wire.status;
    else if (["run-current", "run-show"].includes(args[1]!)) result = { run: wire.run };
    else if (args[0] === "terminal" && args[1] === "show") result = { terminal: wire.terminal };
    else if (args[1] === "task-create") {
      if (wire.failTaskCreate) return { kind: "exited", exitCode: 1, stdout: JSON.stringify({ ok: false, error: { code: "operation_pending", data: { orchestrationRequestId: "fixture-task-request" } } }), stderr: "" };
      wire.spec = args[args.indexOf("--spec") + 1]!;
      result = { task: { id: "fixture-task", run_id: "fixture-run" }, mutation: { requestId: "fixture-task-request" } };
    }
    else if (args[1] === "worker-start") {
      wire.started = true;
      result = { runId: "fixture-run", taskId: "fixture-task", dispatchId: "fixture-dispatch", mutation: { requestId: "fixture-start-request" } };
    }
    else if (args[1] === "task-list") result = { tasks: wire.spec ? [{ id: "fixture-task", run_id: "fixture-run", spec: wire.spec, parent_id: null,
      status: wire.completed ? "completed" : "dispatched" }] : [], page: { hasMore: false } };
    else if (args[1] === "worker-list") result = { workers: wire.started ? [{ runId: "fixture-run", taskId: "fixture-task", dispatchId: "fixture-dispatch",
      identity: { terminal: "fixture-worker", incarnationId: "worker-incarnation", runtimeId: "fixture-home", remoteRuntimeEpoch: null },
      projection: { liveness: { verdict: "live", observedAt: clock.now.getTime() } } }] : [], page: { hasMore: false } };
    else if (args[1] === "request-show") {
      const requestId = args[args.indexOf("--request") + 1]!;
      result = { requestId, state: "completed", receipt: { runId: "fixture-run", taskId: "fixture-task",
        dispatchId: requestId === "fixture-start-request" ? "fixture-dispatch" : null, mutation: { requestId } } };
    }
    else if (args[1] === "worker-show") result = { dispatch: { id: "fixture-dispatch", runId: "fixture-run", taskId: "fixture-task",
      status: wire.completed ? "completed" : "dispatched", completedAt: wire.completed ? at : null }, projection: { taskId: "fixture-task", dispatchId: "fixture-dispatch", outcome: wire.completed ? "succeeded" : null } };
    else if (args[1] === "dispatch-show") result = { dispatch: { id: "fixture-dispatch", run_id: "fixture-run", task_id: "fixture-task",
      status: wire.completed ? "completed" : "dispatched", completed_at: wire.completed ? at : null } };
    else if (args[1] === "check") {
      if (!args.includes("--ack")) wire.afterCheck();
      result = { runId: "fixture-run", deliveryId: args.includes("--ack") ? null : "fixture-delivery", messages: args.includes("--ack") ? [] : wire.messages, count: args.includes("--ack") ? 0 : wire.messages.length,
        acknowledged: args.includes("--ack") ? "fixture-delivery" : null, mutation: { requestId: "fixture-ack-request" } };
    }
    else throw Error(`Unexpected public command: ${args.slice(0, 2).join(" ")}`);
    return { kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result, _meta: { runtimeId: "fixture-home" } }), stderr: "" };
  };
  return { wire, source, commands, runner };
}
function prepared() {
  const s = setup();
  const issue = core.createIssue(s.me, { workspaceId: s.ws.id, title: "通常PMの引継ぎ" });
  const p = prepareSprint(s.me, s.ws.key, [issue.id]);
  const ready = acceptPreparedSprint(s.me, p);
  const sprint = core.activateSprint(s.me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, clock);
  return { ...s, sprint, itemId: p.items[0]!.id };
}
async function self<T>(action: () => Promise<T>) {
  const old = process.env.ORCA_TERMINAL_HANDLE, session = process.env.ORCA_AGENT_SESSION_ID;
  process.env.ORCA_TERMINAL_HANDLE = terminal; delete process.env.ORCA_AGENT_SESSION_ID;
  try { return await action(); }
  finally {
    if (old === undefined) delete process.env.ORCA_TERMINAL_HANDLE; else process.env.ORCA_TERMINAL_HANDLE = old;
    if (session === undefined) delete process.env.ORCA_AGENT_SESSION_ID; else process.env.ORCA_AGENT_SESSION_ID = session;
  }
}

test("caller key absentの正当な通常PMは自己証拠を保存して同じ予約へ引き継ぐ", () => self(async () => {
  const s = prepared(), f = fixture();
  try {
    const adapter = core.createSprintOrcaAdapter(f.runner, { clock, selfMetadataSource: f.source });
    const session = await core.beginSprintSession(s.llm, s.sprint.id, { expectedVersion: s.sprint.version, requestKey: "監督", runId: "fixture-run" }, adapter, clock);
    expect(session).toMatchObject({ caller: terminal, consumerGeneration: 7, callerEvidence: { kind: "native_terminal", metadata: { threadId: thread, turnId: "fixture-turn", status: "observed" }, identity: { terminal, incarnationId: "fixture-incarnation", runtimeId: "fixture-home" } } });
    expect(session.callerIdentity).toBeUndefined();
    const context = { sessionId: session.id, generation: 1 };
    const attempt = core.prepareSprintExecution(s.llm, s.sprint.id, { ...context, requestKey: "予約", itemId: s.itemId, actor: s.llm.actor, spec: "同じ仕事", placement: { agent: "codex", worktree: "path:/fixture" } }, clock);
    f.wire.terminal.incarnationId = "fixture-next-incarnation";
    const resumed = await core.resumeSprintSession(s.llm, s.sprint.id, { ...context, requestKey: "引継ぎ" }, adapter, clock);
    expect(resumed.state).toMatchObject({ occupied: 1, reserved: 1, session: { id: session.id, generation: 2, callerEvidence: { kind: "native_terminal", identity: { incarnationId: "fixture-next-incarnation" } } } });
    expect(resumed.state.attempts[0]?.id).toBe(attempt.id);
    expect(resumed.state.operations[0]).toMatchObject({ state: "prepared", callerEvidence: { kind: "native_terminal", identity: { incarnationId: "fixture-next-incarnation" } } });
    expect(f.commands.filter(a => a[1] === "run-current").every(a => !a.includes("--from"))).toBe(true);
    expect(f.commands.some(a => ["task-create", "worker-start", "send"].includes(a[1]!))).toBe(false);
  } finally { s.db.close(); }
}));

test("同じ既知requestのnative回復を保ち、structured証拠への交代では旧requestを送信しない", () => self(async () => {
  const s = prepared(), f = fixture();
  try {
    const adapter = core.createSprintOrcaAdapter(f.runner, { clock, selfMetadataSource: f.source });
    const session = await core.beginSprintSession(s.llm, s.sprint.id, { expectedVersion: s.sprint.version, requestKey: "監督", runId: "fixture-run" }, adapter, clock);
    const context = { sessionId: session.id, generation: 1 };
    const attempt = core.prepareSprintExecution(s.llm, s.sprint.id, { ...context, requestKey: "予約", itemId: s.itemId, actor: s.llm.actor, spec: "同じ仕事", placement: { agent: "codex", worktree: "path:/fixture" } }, clock);
    f.wire.failTaskCreate = true;
    const unknown = await core.requestSprintExecution(s.llm, s.sprint.id, { ...context, attemptId: attempt.id }, adapter, clock);
    const operation = unknown.operations[0]!;
    // 既存coreの公開request回復seam。独立fixtureは元sender・入力・既知requestを固定する。
    const recovery = { ...adapter, request: async (requestId: string) => ({ state: "pending" as const, requestId, receipt: null,
      source: "回復seamの肯定的な元操作非稼働fixture", observedAt: at, recovery: { originalInactive: true as const, evidence: "fixture-original-inactive",
        argv: ["orca", "orchestration", "task-create", "--spec", core.sprintOrcaTaskSpec(operation), "--run", "fixture-run", "--from", terminal, "--retry-request", "fixture-task-request", "--json"] } }) };
    const before = f.commands.filter(a => a[1] === "task-create").length;
    await core.recoverSprintExecution(s.llm, s.sprint.id, { ...context, operationId: operation.id }, recovery, clock);
    expect(f.commands.filter(a => a[1] === "task-create")).toHaveLength(before + 1);
    expect(f.commands.filter(a => a[1] === "task-create").at(-1)).toContain("--retry-request");
    f.wire.status.caller = { orcaSessionId: "orca_session_id:55555555-5555-4555-8555-555555555555", live: true };
    const result = await core.recoverSprintExecution(s.llm, s.sprint.id, { ...context, operationId: operation.id }, recovery, clock);
    expect(f.commands.filter(a => a[1] === "task-create")).toHaveLength(before + 1);
    expect(result).toMatchObject({ occupied: 1, reserved: 1, operations: [{ id: operation.id, state: "unknown", requestId: "fixture-task-request", callerEvidence: { kind: "native_terminal" } }] });
  } finally { s.db.close(); }
}));

test("本人観測の欠測・不一致・明示refusalは送信せず元予約と要求を保持する", () => self(async () => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void, string?][] = [
    ["借用from", () => {}, "term_33333333-3333-4333-8333-333333333333"],
    ["別terminal", f => { f.wire.terminal.handle = "term_33333333-3333-4333-8333-333333333333"; }],
    ["別cwd", f => { f.wire.terminal.worktreePath = "/different-cwd"; }],
    ["非接続", f => { f.wire.terminal.connected = false; }],
    ["incarnation欠測", f => { f.wire.terminal.incarnationId = ""; }],
    ["incarnation交代", f => { f.wire.terminal.incarnationId = "replacement"; }],
    ["runtime交代", f => { f.wire.status.runtime.runtimeId = "different-runtime"; }],
    ["runtime非ready", f => { f.wire.status.runtime.state = "starting"; }],
    ["runtime非接続", f => { f.wire.status.runtime.connectionState = "disconnected"; }],
    ["caller null", f => { f.wire.status.caller = null; }],
    ["caller明示拒否", f => { f.wire.status.caller = { live: false, refusal: { code: "consumer_fenced" } }; }],
    ["caller不完全", f => { f.wire.status.caller = {}; }],
    ["別UID", f => { f.wire.status.caller = { live: true, orcaSessionId: "different-session" }; }],
    ["別thread", f => { f.source.threadId = "44444444-4444-4444-8444-444444444444"; }],
    ["metadata欠測", f => { f.wire.lines = f.wire.lines.filter(l => !l.includes('"token_usage_record"')); }],
    ["終了turn", f => { f.wire.lines.push(JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "task_complete", turn_id: "fixture-turn" } }) + "\n"); }],
    ["consumer交代", f => { f.wire.run.consumer_generation = 8; }],
    ["別Run", f => { f.wire.run.id = "other-run"; }],
  ];
  for (const [label, change, from] of cases) {
    const s = prepared(), f = fixture();
    try {
      const original = core.createSprintOrcaAdapter(f.runner, { clock, selfMetadataSource: f.source });
      const session = await core.beginSprintSession(s.llm, s.sprint.id, { expectedVersion: s.sprint.version, requestKey: "監督", runId: "fixture-run" }, original, clock);
      const context = { sessionId: session.id, generation: 1 };
      const attempt = core.prepareSprintExecution(s.llm, s.sprint.id, { ...context, requestKey: "予約", itemId: s.itemId, actor: s.llm.actor, spec: "同じ仕事", placement: { agent: "codex", worktree: "path:/fixture" } }, clock);
      change(f);
      const adapter = core.createSprintOrcaAdapter(f.runner, { clock, selfMetadataSource: f.source, from });
      let failure: any;
      try { await core.requestSprintExecution(s.llm, s.sprint.id, { ...context, attemptId: attempt.id }, adapter, clock); } catch (e) { failure = e; }
      expect(failure?.code, label).toMatch(/ORCA_OBSERVATION_UNKNOWN|AUTHORITY_CHANGED/);
      expect(failure?.message.length, label).toBeGreaterThan(0);
      expect(f.commands.filter(a => ["task-create", "worker-start", "send", "reply", "worker-release"].includes(a[1]!) || a.includes("--ack")), label).toHaveLength(0);
      expect(core.getSprintExecutionState(s.db, s.sprint.id, clock), label).toMatchObject({ occupied: 1, reserved: 1, operations: [{ state: "prepared", requestId: null }] });
    } finally { s.db.close(); }
  }
}));

test("authority取得の途中でconsumer・Run・incarnation・runtimeが変わると開始しない", () => self(async () => {
  for (const kind of ["consumer", "run", "incarnation", "runtime"] as const) {
    const s = prepared(), f = fixture(); let statuses = 0;
    try {
      f.wire.beforeCommand = args => {
        if (args[0] !== "status" || ++statuses !== 2) return;
        if (kind === "consumer") f.wire.run.consumer_generation = 8;
        if (kind === "run") f.wire.run.id = "other-run";
        if (kind === "incarnation") f.wire.terminal.incarnationId = "replacement";
        if (kind === "runtime") f.wire.status.runtime.runtimeId = "replacement";
      };
      await expect(core.beginSprintSession(s.llm, s.sprint.id, { expectedVersion: s.sprint.version, requestKey: "監督", runId: "fixture-run" }, core.createSprintOrcaAdapter(f.runner, { clock, selfMetadataSource: f.source }), clock)).rejects.toMatchObject({ code: "ORCA_OBSERVATION_UNKNOWN" });
      expect(core.getSprintExecutionState(s.db, s.sprint.id, clock).session).toBeNull();
    } finally { s.db.close(); }
  }
}));

test("usageの増加だけでは本人交代とせず同じ通常PMが一度だけ起動できる", () => self(async () => {
  const s = prepared(), f = fixture(); let read = 0;
  try {
    f.source.snapshots = () => [{ filename: `rollout-${thread}.jsonl`, lines: f.wire.lines.map(l => l.includes('"token_usage_record"') ? l.replace(at, new Date(clock.now.getTime() + ++read).toISOString()) : l) }];
    const adapter = core.createSprintOrcaAdapter(f.runner, { clock, selfMetadataSource: f.source });
    const session = await core.beginSprintSession(s.llm, s.sprint.id, { expectedVersion: s.sprint.version, requestKey: "監督", runId: "fixture-run" }, adapter, clock);
    const context = { sessionId: session.id, generation: 1 };
    const attempt = core.prepareSprintExecution(s.llm, s.sprint.id, { ...context, requestKey: "予約", itemId: s.itemId, actor: s.llm.actor, spec: "同じ仕事", placement: { agent: "codex", worktree: "path:/fixture" } }, clock);
    const result = await core.requestSprintExecution(s.llm, s.sprint.id, { ...context, attemptId: attempt.id }, adapter, clock);
    expect(result).toMatchObject({ occupied: 1, attempts: [{ id: attempt.id, taskId: "fixture-task", dispatchId: "fixture-dispatch" }], operations: [{ state: "confirmed" }, { state: "confirmed" }] });
    await core.requestSprintExecution(s.llm, s.sprint.id, { ...context, attemptId: attempt.id }, adapter, clock);
    expect(f.commands.filter(a => a[1] === "task-create")).toHaveLength(1);
    expect(f.commands.filter(a => a[1] === "worker-start")).toHaveLength(1);
  } finally { s.db.close(); }
}));

test("送信直前のconsumer交代でもTaskを作らず元operationと予約をunknownで保持する", () => self(async () => {
  const s = prepared(), f = fixture();
  try {
    const adapter = core.createSprintOrcaAdapter(f.runner, { clock, selfMetadataSource: f.source });
    const session = await core.beginSprintSession(s.llm, s.sprint.id, { expectedVersion: s.sprint.version, requestKey: "監督", runId: "fixture-run" }, adapter, clock);
    const context = { sessionId: session.id, generation: 1 };
    const attempt = core.prepareSprintExecution(s.llm, s.sprint.id, { ...context, requestKey: "予約", itemId: s.itemId, actor: s.llm.actor, spec: "同じ仕事", placement: { agent: "codex", worktree: "path:/fixture" } }, clock);
    const operationId = core.getSprintExecutionState(s.db, s.sprint.id, clock).operations[0]!.id;
    let reads = 0;
    f.wire.beforeCommand = args => { if (args[0] === "status" && ++reads === 3) f.wire.run.consumer_generation = 8; };
    const result = await core.requestSprintExecution(s.llm, s.sprint.id, { ...context, attemptId: attempt.id }, adapter, clock);
    expect(result).toMatchObject({ occupied: 1, reserved: 1, operations: [{ id: operationId, state: "unknown", requestId: null, reason: { code: "RESPONSE_UNKNOWN" } }] });
    expect(f.commands.filter(a => ["task-create", "worker-start"].includes(a[1]!))).toHaveLength(0);
  } finally { s.db.close(); }
}));

test("通常PMの監督交代が先でも後でも旧PMを止め、元workerの正当な報告を受理する", () => self(async () => {
  for (const order of ["handover-first", "old-request-first"]) {
    const s = prepared(), f = fixture();
    try {
      const adapter = core.createSprintOrcaAdapter(f.runner, { clock, selfMetadataSource: f.source });
      const session = await core.beginSprintSession(s.llm, s.sprint.id, { expectedVersion: s.sprint.version, requestKey: "監督", runId: "fixture-run" }, adapter, clock);
      const old = { sessionId: session.id, generation: 1 };
      const attempt = core.prepareSprintExecution(s.llm, s.sprint.id, { ...old, requestKey: "予約", itemId: s.itemId, actor: s.llm.actor, spec: "同じ仕事", placement: { agent: "codex", worktree: "path:/fixture" } }, clock);
      await core.requestSprintExecution(s.llm, s.sprint.id, { ...old, attemptId: attempt.id }, adapter, clock);
      const before = core.getSprintExecutionState(s.db, s.sprint.id, clock);
      if (order === "old-request-first") {
        let intent = false;
        f.wire.beforeCommand = args => {
          if (!intent && args[0] === "status") { intent = true; core.beginSprintHandover(s.llm, s.sprint.id, { ...old, requestKey: "競合intent" }); }
        };
        await expect(core.requestSprintExecution(s.llm, s.sprint.id, { ...old, attemptId: attempt.id }, adapter, clock)).rejects.toMatchObject({ code: "HANDOVER_PENDING" });
        f.wire.beforeCommand = () => {};
      }
      f.wire.terminal.incarnationId = "successor-incarnation"; f.wire.run.consumer_generation = 8;
      const resumed = await core.resumeSprintSession(s.llm, s.sprint.id, { ...old, requestKey: order === "old-request-first" ? "競合intent" : "交代" }, adapter, clock);
      expect(resumed.state).toMatchObject({ occupied: 1, session: { id: session.id, generation: 2, consumerGeneration: 8 } });
      expect(resumed.state.operations.map(o => [o.id, o.requestId])).toEqual(before.operations.map(o => [o.id, o.requestId]));
      await expect(core.requestSprintExecution(s.llm, s.sprint.id, { ...old, attemptId: attempt.id }, adapter, clock)).rejects.toMatchObject({ code: "STALE_GENERATION" });
      f.wire.messages = [{ id: "fixture-worker-report", run_id: "fixture-run", from_handle: "dispatch:fixture-dispatch", type: "heartbeat",
        payload: JSON.stringify({ taskId: "fixture-task", dispatchId: "fixture-dispatch", phase: "implementing" }) }];
      const result = await core.receiveSprintNotifications(s.llm, s.sprint.id, { ...old, generation: 2 }, adapter, clock);
      expect(result).toMatchObject({ results: [{ kind: "notice", attemptId: attempt.id }], deliveries: [{ acknowledged: true }], execution: { occupied: 1, attempts: [{ id: attempt.id, taskId: "fixture-task", dispatchId: "fixture-dispatch" }] } });
      expect(f.commands.filter(a => a[1] === "task-create")).toHaveLength(1);
      expect(f.commands.filter(a => a[1] === "worker-start")).toHaveLength(1);
    } finally { s.db.close(); }
  }
}));

test("配送取得中に同terminalのincarnationが交代すれば旧PMはackを送らず予約を保つ", () => self(async () => {
  const s = prepared(), f = fixture();
  try {
    const adapter = core.createSprintOrcaAdapter(f.runner, { clock, selfMetadataSource: f.source });
    const session = await core.beginSprintSession(s.llm, s.sprint.id, { expectedVersion: s.sprint.version, requestKey: "監督", runId: "fixture-run" }, adapter, clock);
    const context = { sessionId: session.id, generation: 1 };
    core.prepareSprintExecution(s.llm, s.sprint.id, { ...context, requestKey: "予約", itemId: s.itemId, actor: s.llm.actor, spec: "同じ仕事", placement: { agent: "codex", worktree: "path:/fixture" } }, clock);
    f.wire.afterCheck = () => { f.wire.terminal.incarnationId = "replaced-during-delivery"; };
    const result = await core.receiveSprintNotifications(s.llm, s.sprint.id, context, adapter, clock);
    expect(f.commands.filter(a => a.includes("--ack"))).toHaveLength(0);
    expect(result).toMatchObject({ execution: { occupied: 1, reserved: 1 }, deliveries: [{ acknowledged: false, ackOperation: { state: "unknown", callerEvidence: { kind: "native_terminal" } } }] });
  } finally { s.db.close(); }
}));

test("返信と正規解放も送信直前の本人交代を拒み同workerの結果と操作証拠を保持する", () => self(async () => {
  for (const kind of ["question", "worker_done"]) {
    const s = prepared(), f = fixture();
    try {
      const adapter = core.createSprintOrcaAdapter(f.runner, { clock, selfMetadataSource: f.source });
      const session = await core.beginSprintSession(s.llm, s.sprint.id, { expectedVersion: s.sprint.version, requestKey: "監督", runId: "fixture-run" }, adapter, clock);
      const context = { sessionId: session.id, generation: 1 };
      const attempt = core.prepareSprintExecution(s.llm, s.sprint.id, { ...context, requestKey: "予約", itemId: s.itemId, actor: s.llm.actor, spec: "同じ仕事", placement: { agent: "codex", worktree: "path:/fixture" } }, clock);
      await core.requestSprintExecution(s.llm, s.sprint.id, { ...context, attemptId: attempt.id }, adapter, clock);
      const common = { id: "fixture-result", run_id: "fixture-run", from_handle: "dispatch:fixture-dispatch", type: kind };
      f.wire.messages = [{ ...common, payload: JSON.stringify(kind === "question" ? { taskId: "fixture-task", dispatchId: "fixture-dispatch", question: "確認先", options: [] }
        : { taskId: "fixture-task", dispatchId: "fixture-dispatch", outcome: "succeeded" }) }];
      if (kind === "question") f.wire.afterCheck = () => { f.wire.terminal.incarnationId = "replaced-before-reply"; };
      else {
        f.wire.completed = true;
        f.wire.beforeCommand = args => { if (args[1] === "worker-show") f.wire.terminal.incarnationId = "replaced-before-release"; };
      }
      const result = await core.receiveSprintNotifications(s.llm, s.sprint.id, { ...context,
        ...(kind === "question" ? { answers: [{ messageId: "fixture-result", body: "成果資料" }] } : { ownership: [{ dispatchId: "fixture-dispatch", action: "release" as const }] }) }, adapter, clock);
      expect(f.commands.filter(a => ["reply", "worker-release"].includes(a[1]!) || a.includes("--ack"))).toHaveLength(0);
      expect(result.execution).toMatchObject({ occupied: 1, attempts: [{ id: attempt.id, taskId: "fixture-task", dispatchId: "fixture-dispatch" }] });
      if (kind === "question") expect(result.receptions[0]?.reply).toMatchObject({ state: "unknown", callerEvidence: { kind: "native_terminal", identity: { incarnationId: "fixture-incarnation" } } });
      else expect(result.results[0]?.completion?.releaseOperation).toMatchObject({ state: "unknown", callerEvidence: { kind: "native_terminal", identity: { incarnationId: "fixture-incarnation" } } });
    } finally { s.db.close(); }
  }
}));

test("structured callerのUIDだけがあっても正式live観測が欠ければ開始しない", () => self(async () => {
  const s = prepared(), f = fixture();
  try {
    f.wire.status.caller = { orcaSessionId: "orca_session_id:fixture-session" };
    await expect(core.beginSprintSession(s.llm, s.sprint.id, { expectedVersion: s.sprint.version, requestKey: "監督", runId: "fixture-run" }, core.createSprintOrcaAdapter(f.runner, { clock, from: terminal }), clock)).rejects.toMatchObject({ code: "ORCA_OBSERVATION_UNKNOWN" });
    expect(core.getSprintExecutionState(s.db, s.sprint.id, clock).session).toBeNull();
  } finally { s.db.close(); }
}));

test("structuredの正式host解決addressを保存しraw injected UIDとの単純一致を要求しない", () => self(async () => {
  const s = prepared(), f = fixture(), address = "orca_session_id:55555555-5555-4555-8555-555555555555";
  try {
    process.env.ORCA_AGENT_SESSION_ID = "66666666-6666-4666-8666-666666666666";
    f.wire.status.caller = { orcaSessionId: address, live: true }; f.wire.run.coordinator_handle = address;
    const adapter = core.createSprintOrcaAdapter(f.runner, { clock, from: address });
    const session = await core.beginSprintSession(s.llm, s.sprint.id, { expectedVersion: s.sprint.version, requestKey: "監督", runId: "fixture-run" }, adapter, clock);
    expect(session).toMatchObject({ caller: address, callerIdentity: address, callerEvidence: { kind: "orca_session", orcaSessionId: address } });
    const context = { sessionId: session.id, generation: 1 };
    const attempt = core.prepareSprintExecution(s.llm, s.sprint.id, { ...context, requestKey: "予約", itemId: s.itemId, actor: s.llm.actor, spec: "同じ仕事", placement: { agent: "codex", worktree: "path:/fixture" } }, clock);
    await core.requestSprintExecution(s.llm, s.sprint.id, { ...context, attemptId: attempt.id }, adapter, clock);
    expect(f.commands.filter(a => a[1] === "task-create")).toHaveLength(1);
    expect(f.commands.filter(a => a[1] === "worker-start")).toHaveLength(1);
    expect(f.commands.filter(a => a[0] === "terminal")).toHaveLength(0);
    f.wire.status.caller = { orcaSessionId: "orca_session_id:77777777-7777-4777-8777-777777777777", live: true };
    await expect(core.requestSprintExecution(s.llm, s.sprint.id, { ...context, attemptId: attempt.id }, adapter, clock)).rejects.toMatchObject({ code: "AUTHORITY_CHANGED" });
    expect(core.getSprintExecutionState(s.db, s.sprint.id, clock)).toMatchObject({ occupied: 1, operations: [{ callerEvidence: { kind: "orca_session", orcaSessionId: address } }, { callerEvidence: { kind: "orca_session", orcaSessionId: address } }] });
  } finally { s.db.close(); }
}));

test("structured指定時のabsent・null・refusal・不完全UIDを通常terminalへ回避しない", () => self(async () => {
  process.env.ORCA_AGENT_SESSION_ID = "55555555-5555-4555-8555-555555555555";
  for (const caller of [undefined, null, {}, { live: true }, { orcaSessionId: "raw-uid", live: true },
    { orcaSessionId: "orca_session_id:", live: true },
    { orcaSessionId: "orca_session_id:55555555-5555-4555-8555-555555555555", live: false, refusal: { code: "session_caller_not_live" } }]) {
    const s = prepared(), f = fixture();
    try {
      if (caller !== undefined) f.wire.status.caller = caller;
      const adapter = core.createSprintOrcaAdapter(f.runner, { clock, from: terminal, selfMetadataSource: f.source });
      await expect(core.beginSprintSession(s.llm, s.sprint.id, { expectedVersion: s.sprint.version, requestKey: "監督", runId: "fixture-run" }, adapter, clock)).rejects.toMatchObject({ code: "ORCA_OBSERVATION_UNKNOWN" });
      expect(core.getSprintExecutionState(s.db, s.sprint.id, clock).session).toBeNull();
      expect(f.commands.filter(a => a[0] === "terminal" || ["task-create", "worker-start"].includes(a[1]!))).toHaveLength(0);
    } finally { s.db.close(); }
  }
}));
