import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "@nod/core";
import { makeRepo, runNod, tempDb, tempDir } from "./helpers";
import { prepareSprint, acceptPreparedSprint, sprintTestClock } from "../../core/test/fixtures/sprint-start";

test("CLIの通常PMは既定自己collectorで開始し、借用fromの実行依頼は送信しない", async () => {
  const cwd = makeRepo(), path = tempDb(), db = core.openDb(path), dir = tempDir();
  const me = { db, actor: "me" }, ws = core.initWorkspace(db, { path: cwd }).workspace;
  const issue = core.createIssue(me, { workspaceId: ws.id, title: "通常PMの公開入口" });
  const p = prepareSprint(me, ws.key, [issue.id]);
  const period = core.updateSprint(me, p.sprint.id, { expectedVersion: p.sprint.version, requestKey: "期間", startDate: "2000-01-01", endDate: "2999-01-01" });
  const proposed = core.proposeSprintPlan(me, period.id, { ...p.input, expectedVersion: period.version, requestKey: "通常PM計画" });
  const ready = core.acceptSprintPlan(me, period.id, proposed.plan.id, { expectedVersion: proposed.sprint.version, requestKey: "合意", contentHash: proposed.plan.contentHash });
  const sprint = core.activateSprint(me, period.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }); db.close();
  const terminal = "term_22222222-2222-4222-8222-222222222222", thread = "11111111-1111-4111-8111-111111111111";
  const metadataDir = join(dir, "sessions/2026/10/29"); mkdirSync(metadataDir, { recursive: true });
  const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
  writeFileSync(join(metadataDir, `rollout-${thread}.jsonl`), [
    line("session_meta", { id: thread, cwd, cli_version: "0.164.0", originator: "codex-tui", source: "cli", model_provider: "openai" }),
    line("event_msg", { type: "task_started", turn_id: "native-turn" }),
    line("turn_context", { turn_id: "native-turn", cwd, model: "gpt-6.1-sol", effort: "high" }),
    line("event_msg", { type: "thread_settings_applied", thread_id: thread, thread_settings: { cwd, model: "gpt-6.1-sol", reasoning_effort: "high", model_provider_id: "openai" } }),
    line("token_usage_record", { thread_id: thread, session_id: thread, turn_id: "native-turn", root_turn_id: "native-turn" }),
  ].join(""));
  const fake = join(dir, "orca.ts"), saved = join(dir, "commands.json");
  writeFileSync(fake, `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const a=process.argv.slice(2),file=process.env.NOD_TEST_ORCA_STATE!,commands=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[];commands.push(a);writeFileSync(file,JSON.stringify(commands));let result;
if(a[0]==='status')result={runtime:{runtimeId:'native-home',state:'ready',reachable:true,connectionState:'connected'}};
else if(a[0]==='terminal')result={terminal:{handle:${JSON.stringify(terminal)},incarnationId:'native-incarnation',connected:true,agentIdentity:'codex',worktreePath:process.cwd()}};
else if(['run-current','run-show'].includes(a[1])){if(a[1]==='run-current'&&a.includes('--from'))throw Error('default本人resolver必須');result={run:{id:'native-run',coordinator_handle:${JSON.stringify(terminal)},consumer_generation:1}};}
else if(a[1]==='task-create')result={task:{id:'native-task',run_id:'native-run'},mutation:{requestId:'native-task-request'}};
else if(a[1]==='worker-start')result={runId:'native-run',taskId:'native-task',dispatchId:'native-dispatch',mutation:{requestId:'native-start-request'}};
else throw Error('unexpected command');console.log(JSON.stringify({ok:true,result,_meta:{runtimeId:'native-home'}}));`);
  const opts = { cwd, db: path, actor: "codex", env: { NOD_ORCA: "1", ORCA_CLI_COMMAND: `bun ${fake}`, NOD_TEST_ORCA_STATE: saved,
    ORCA_TERMINAL_HANDLE: terminal, CODEX_THREAD_ID: thread, CODEX_HOME: dir, ORCA_AGENT_SESSION_ID: "" } };
  const input = join(dir, "input.json");
  writeFileSync(input, JSON.stringify({ expectedVersion: sprint.version, requestKey: "監督", runId: "native-run" }));
  const begin = await runNod(["sprint", "session", "begin", sprint.id, "--input", input, "--json"], opts);
  expect(begin).toMatchObject({ exitCode: 0, json: { callerEvidence: { kind: "native_terminal", metadata: { threadId: thread }, identity: { terminal, incarnationId: "native-incarnation" } } } });
  expect(begin.json.callerIdentity).toBeUndefined();
  const context = { sessionId: begin.json.id, generation: 1 };
  writeFileSync(input, JSON.stringify({ ...context, requestKey: "担当", itemId: p.items[0]!.id, actor: "codex", spec: "仕事", placement: { agent: "codex", worktree: "path:/native" } }));
  const requested = await runNod(["sprint", "execution", "request", sprint.id, "--input", input, "--json"], opts);
  expect(requested).toMatchObject({ exitCode: 0, json: { occupied: 1, attempts: [{ taskId: "native-task", dispatchId: "native-dispatch" }] } });
  writeFileSync(input, JSON.stringify({ ...context, attemptId: requested.json.attempts[0].id }));
  const rejected = await runNod(["sprint", "execution", "request", sprint.id, "--input", input, "--from", "term_33333333-3333-4333-8333-333333333333", "--json"], opts);
  expect(rejected).toMatchObject({ exitCode: 1, json: { error: { code: "ORCA_OBSERVATION_UNKNOWN" } } });
  const commands: string[][] = JSON.parse(readFileSync(saved, "utf8"));
  expect(commands.filter(a => ["task-create", "worker-start"].includes(a[1]!))).toHaveLength(2);
});

test("CLIは同じ公開coreの監督・予約・不明理由と再照合操作をJSONと日本語で表示する", async () => {
  const cwd = makeRepo(), path = tempDb(), db = core.openDb(path), inputDir = tempDir();
  const me = { db, actor: "me" }, llm = { db, actor: "codex" };
  const ws = core.initWorkspace(db, { path: cwd }).workspace;
  const issue = core.createIssue(me, { workspaceId: ws.id, title: "再開する仕事" });
  const prepared = prepareSprint(me, ws.key, [issue.id]), ready = acceptPreparedSprint(me, prepared);
  const sprint = core.activateSprint(me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  const session = await core.beginSprintSession(llm, sprint.id, { expectedVersion: sprint.version, requestKey: "監督", runId: "元Run" }, {
    authority: async () => ({ runId: "元Run", caller: "監督", coordinator: "監督", consumerGeneration: 7, runtimeId: "元runtime", source: "Orcaの観測", observedAt: sprintTestClock.now.toISOString() }),
  }, sprintTestClock);
  const attempt = core.prepareSprintExecution(llm, sprint.id, { sessionId: session.id, generation: 1, requestKey: "主担当", itemId: prepared.items[0]!.id,
    actor: "codex", spec: "合意した仕事", placement: { agent: "codex", worktree: "path:/専用" } }, sprintTestClock);
  db.close();
  const json = await runNod(["sprint", "execution", "show", sprint.id, "--json"], { cwd, db: path, actor: "codex" });
  expect(json).toMatchObject({ exitCode: 0, json: { occupied: 1, reserved: 1, canStart: false, session: { runId: "元Run", generation: 1 } } });
  expect(json.json.attempts[0]).toMatchObject({ id: attempt.id, reason: { code: "HOST_OBSERVATION_REQUIRED" } });
  const human = await runNod(["sprint", "execution", "show", sprint.id], { cwd, db: path, actor: "codex" });
  expect(human.stdout).toContain("現在の監督"); expect(human.stdout).toContain("予約"); expect(human.stdout).toContain("元Run");
  expect(human.stdout).toContain("実行設定"); expect(human.stdout).toContain("'execution' 'reconcile'");
  expect(human.stdout).not.toContain("未実装");
  const file = join(inputDir, "照合.json"); writeFileSync(file, JSON.stringify({ sessionId: session.id, generation: 1 }));
  const unknown = await runNod(["sprint", "execution", "reconcile", sprint.id, "--input", file, "--json"], { cwd, db: path, actor: "codex" });
  expect(unknown).toMatchObject({ exitCode: 0, json: { occupied: 1, canStart: false } });
});

test("CLIのbegin・request・observe・resumeが同じ元Runの担当へ合流し、旧世代の依頼を拒否する", async () => {
  const cwd = makeRepo(), path = tempDb(), db = core.openDb(path), dir = tempDir();
  const me = { db, actor: "me" }, ws = core.initWorkspace(db, { path: cwd }).workspace;
  const issue = core.createIssue(me, { workspaceId: ws.id, title: "引き継ぐ仕事" });
  const original = prepareSprint(me, ws.key, [issue.id]);
  const changed = core.updateSprint(me, original.sprint.id, { expectedVersion: original.sprint.version, requestKey: "試験期間", startDate: "2000-01-01", endDate: "2999-01-01" });
  const proposal = core.proposeSprintPlan(me, changed.id, { ...original.input, expectedVersion: changed.version, requestKey: "現在の計画" });
  const ready = core.acceptSprintPlan(me, changed.id, proposal.plan.id, { expectedVersion: proposal.sprint.version, requestKey: "現在の合意", contentHash: proposal.plan.contentHash });
  const sprint = core.activateSprint(me, changed.id, { expectedVersion: ready.sprint.version, requestKey: "現在の開始" });
  db.close();
  const fake = join(dir, "Orca代役.ts"), saved = join(dir, "送信.json");
  writeFileSync(fake, `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2),file=process.env.NOD_TEST_ORCA_STATE!;
const state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{commands:[],spec:null,started:false};state.commands.push(args);
const coordinator=process.env.NOD_TEST_COORDINATOR??'監督A';let result;
if(args[0]==='status')result={runtime:{runtimeId:'home-runtime',state:'ready',reachable:true,connectionState:'connected'},...(process.env.NOD_TEST_MISSING_CALLER?'':{caller:{orcaSessionId:'orca_session_id:'+coordinator,live:true}})};
else if(args[1]==='run-use'){if(args.includes('--from'))throw Error('旧callerの借用禁止');state.bound=coordinator;result={run:{id:'元Run',coordinator_handle:coordinator,consumer_generation:8}};}
else if(['run-current','run-show'].includes(args[1]!))result={run:{id:'元Run',coordinator_handle:coordinator,consumer_generation:coordinator==='監督A'?7:8}};
else if(args[1]==='task-create'){state.spec=args[args.indexOf('--spec')+1];result={task:{id:'元Task',run_id:'元Run'},mutation:{requestId:'Task要求'}};}
else if(args[1]==='worker-start'){state.started=true;result={runId:'元Run',taskId:'元Task',dispatchId:'元Dispatch',mutation:{requestId:'起動要求'}};}
else if(args[1]==='task-list')result={tasks:[{id:'元Task',run_id:'元Run',spec:state.spec,parent_id:null}]};
else if(args[1]==='worker-list')result={workers:state.started?[{runId:'元Run',taskId:'元Task',dispatchId:'元Dispatch',identity:{runtimeId:'host',incarnationId:'incarnation',terminal:'端末',remoteRuntimeEpoch:'epoch'},projection:{liveness:{verdict:'live',observedAt:Date.now()}}}]:[],page:{hasMore:false,nextCursor:null}};
else if(args[1]==='request-show'){const id=args[args.indexOf('--request')+1];result={requestId:id,state:'completed',receipt:{runId:'元Run',taskId:'元Task',dispatchId:id==='起動要求'?'元Dispatch':null,mutation:{requestId:id}}};}
else throw Error('想定外の操作');writeFileSync(file,JSON.stringify(state));process.stdout.write(JSON.stringify({ok:true,result,_meta:{runtimeId:'home-runtime'}})+'\\n');
`);
  const env = { NOD_ORCA: "1", ORCA_CLI_COMMAND: `bun ${fake}`, NOD_TEST_ORCA_STATE: saved };
  let sequence = 0;
  const run = async (route: string[], body: unknown, caller = "監督A") => {
    const file = join(dir, `${++sequence}.json`); writeFileSync(file, JSON.stringify(body));
    return runNod(["sprint", ...route, sprint.id, "--input", file, "--from", caller, "--json"], { cwd, db: path, actor: "codex", env: { ...env, NOD_TEST_COORDINATOR: caller } });
  };
  const begin = await run(["session", "begin"], { expectedVersion: sprint.version, requestKey: "監督", runId: "元Run" });
  expect(begin).toMatchObject({ exitCode: 0, json: { generation: 1, consumerGeneration: 7 } });
  const context = { sessionId: begin.json.id, generation: 1 };
  const request = await run(["execution", "request"], { ...context, requestKey: "担当", itemId: original.items[0]!.id, actor: "codex", spec: "合意した仕事", placement: { agent: "codex", worktree: "path:/専用" } });
  expect(request).toMatchObject({ exitCode: 0, json: { occupied: 1, canStart: false } });
  expect(request.json.attempts[0]).toMatchObject({ taskId: "元Task", dispatchId: "元Dispatch" });
  const observed = await run(["session", "observe"], context);
  expect(observed.json.snapshot).toMatchObject({ resolved: true, planId: ready.plan.id, planHash: ready.plan.contentHash });
  expect(observed.json.state.nextActions).toContainEqual(expect.objectContaining({ argv: ["nod", "sprint", "session", "resume", sprint.id, "--input", "-"] }));
  const action = observed.json.state.nextActions.find((a: any) => a.argv.includes("resume"));
  expect(action.command).not.toContain("--from");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  writeFileSync(join(dir, "nod"), `#!/bin/sh\nexec bun ${quote(join(import.meta.dir, "../src/main.ts"))} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(dir, "orca"), `#!/bin/sh\nexec bun ${quote(fake)} "$@"\n`, { mode: 0o755 });
  const copied = async (missing: boolean) => {
    const child = Bun.spawn(["/bin/sh", "-c", `${action.command} --json`], { cwd, env: { ...process.env, ...env, NOD_DB: path,
      NOD_ACTOR: "", NOD_TEST_COORDINATOR: "監督B", ORCA_TERMINAL_HANDLE: "監督B", ORCA_AGENT_SESSION_ID: "", CODEX_THREAD_ID: "",
      NOD_TEST_MISSING_CALLER: missing ? "1" : "", PATH: `${dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(""); return { exitCode, json: JSON.parse(stdout.split("\n").slice(3).join("\n")) };
  };
  const unavailable = await copied(true);
  expect(unavailable).toMatchObject({ exitCode: 0, json: { snapshot: { resolved: false }, state: { session: { generation: 1, state: "handover", caller: "監督A" }, occupied: 1 } } });
  const resumed = await copied(false);
  expect(resumed).toMatchObject({ exitCode: 0, json: { state: { session: { generation: 2, caller: "監督B", consumerGeneration: 8, planId: ready.plan.id, planHash: ready.plan.contentHash }, occupied: 1 } } });
  expect(resumed.json.state.attempts[0]).toMatchObject({ id: request.json.attempts[0].id, taskId: "元Task", dispatchId: "元Dispatch", canStart: false });
  expect(resumed.json.state.operations.map((o: core.SprintExecutionOperation) => o.requestId)).toEqual(["Task要求", "起動要求"]);
  expect(await run(["execution", "request"], { ...context, attemptId: request.json.attempts[0].id }, "監督A")).toMatchObject({ exitCode: 1, json: { error: { code: "STALE_GENERATION" } } });
  // 同計画のコピー再開に加え、既存の新合意へ再開する経路も維持する。
  const latestDb = core.openDb(path), latestCtx = { db: latestDb, actor: "me" };
  const revised = core.proposeSprintPlan(latestCtx, sprint.id, { ...original.input, expectedVersion: core.getSprint(latestDb, sprint.id).version,
    requestKey: "新計画", goal: "人が正式に変えたゴール", changeReason: "同じ担当へ新合意を渡す" });
  core.acceptSprintPlan(latestCtx, sprint.id, revised.plan.id, { expectedVersion: revised.sprint.version, requestKey: "新合意", contentHash: revised.plan.contentHash });
  latestDb.close();
  const current = { ...context, generation: 2 };
  const replannedObservation = await run(["session", "observe"], current, "監督B");
  expect(replannedObservation.json.snapshot).toMatchObject({ resolved: true, planId: revised.plan.id, planHash: revised.plan.contentHash });
  const replanned = await run(["session", "resume"], { ...current, requestKey: "新合意の引継ぎ" }, "監督C");
  expect(replanned).toMatchObject({ exitCode: 0, json: { state: { session: { generation: 3, caller: "監督C", planId: revised.plan.id, planHash: revised.plan.contentHash }, occupied: 1 } } });
  expect(replanned.json.state.attempts[0]).toMatchObject({ id: request.json.attempts[0].id, taskId: "元Task", dispatchId: "元Dispatch", canStart: false });
  expect(replanned.json.state.operations.map((o: core.SprintExecutionOperation) => o.requestId)).toEqual(["Task要求", "起動要求"]);
});

test("CLIは通常着手の元担当と未照合占有を表示し、別採択Issueの予約を同じcoreで拒否する", async () => {
  const cwd = makeRepo(), path = tempDb(), db = core.openDb(path), dir = tempDir();
  const me = { db, actor: "me" }, llm = { db, actor: "codex" }, ws = core.initWorkspace(db, { path: cwd }).workspace;
  const a = core.createIssue(me, { workspaceId: ws.id, title: "先に着手した仕事" });
  const b = core.createIssue(me, { workspaceId: ws.id, title: "次の採択仕事" });
  core.startIssue(llm, a.id);
  const original = prepareSprint(me, ws.key, [a.id, b.id]);
  const period = core.updateSprint(me, original.sprint.id, { expectedVersion: original.sprint.version, requestKey: "試験期間", startDate: "2000-01-01", endDate: "2999-01-01" });
  const proposed = core.proposeSprintPlan(me, period.id, { ...original.input, expectedVersion: period.version, requestKey: "現在の計画" });
  const ready = core.acceptSprintPlan(me, period.id, proposed.plan.id, { expectedVersion: proposed.sprint.version, requestKey: "現在の合意", contentHash: proposed.plan.contentHash });
  const sprint = core.activateSprint(me, period.id, { expectedVersion: ready.sprint.version, requestKey: "現在の開始" });
  const session = await core.beginSprintSession(llm, sprint.id, { expectedVersion: sprint.version, requestKey: "監督", runId: "元Run" }, {
    authority: async () => ({ runId: "元Run", caller: "監督", coordinator: "監督", consumerGeneration: 1, runtimeId: "home", source: "模擬の現在権限", observedAt: new Date().toISOString() }),
  });
  db.close();
  const observed = await runNod(["sprint", "execution", "show", sprint.id, "--json"], { cwd, db: path, actor: "codex" });
  expect(observed).toMatchObject({ exitCode: 0, json: { occupied: 1, reserved: 0, attempts: [], unreconciledOwnership: [{ sourceIssueKey: a.id, assignee: "codex", status: "in_progress" }] } });
  const human = await runNod(["sprint", "execution", "show", sprint.id], { cwd, db: path, actor: "codex" });
  expect(human.stdout).toContain("通常経路の既存所有: codex"); expect(human.stdout).toContain("EXISTING_EXECUTION_UNRECONCILED");
  const file = join(dir, "予約.json");
  writeFileSync(file, JSON.stringify({ sessionId: session.id, generation: 1, requestKey: "別の仕事", itemId: original.items[1]!.id,
    actor: "codex", spec: "Bを始める", placement: { agent: "codex", worktree: "path:/専用" } }));
  expect(await runNod(["sprint", "execution", "request", sprint.id, "--input", file, "--json"], { cwd, db: path, actor: "codex" }))
    .toMatchObject({ exitCode: 1, json: { error: { code: "PARALLEL_LIMIT" } } });
});

test("表示した完全な再照合手順をactor補充なしで実行し、保存した同世代の予約と拒否理由を読む", async () => {
  const cwd = makeRepo(), path = tempDb(), dir = tempDir(), db = core.openDb(path);
  const me = { db, actor: "me" }, agent = { db, actor: "codex" };
  const ws = core.initWorkspace(db, { path: cwd }).workspace;
  const issue = core.createIssue(me, { workspaceId: ws.id, title: "コピー手順で照合する" });
  const planned = prepareSprint(me, ws.key, [issue.id]);
  const period = core.updateSprint(me, planned.sprint.id, { expectedVersion: planned.sprint.version, requestKey: "期間", startDate: "2000-01-01", endDate: "2999-01-01" });
  const proposal = core.proposeSprintPlan(me, period.id, { ...planned.input, expectedVersion: period.version, requestKey: "期間変更後の計画" });
  const ready = core.acceptSprintPlan(me, period.id, proposal.plan.id, { expectedVersion: proposal.sprint.version, requestKey: "合意", contentHash: proposal.plan.contentHash });
  const sprint = core.activateSprint(me, period.id, { expectedVersion: ready.sprint.version, requestKey: "開始" });
  const caller = "監督 ' $(nod37_should_never_run)";
  const session = await core.beginSprintSession(agent, sprint.id, { expectedVersion: sprint.version, requestKey: "監督", runId: "元Run" }, {
    authority: async () => ({ runId: "元Run", caller, coordinator: caller, consumerGeneration: 1, runtimeId: "home", source: "模擬Orca", observedAt: new Date().toISOString() }),
  });
  core.prepareSprintExecution(agent, sprint.id, { sessionId: session.id, generation: 1, requestKey: "担当", itemId: planned.items[0]!.id,
    actor: "codex", spec: "確認する", placement: { agent: "codex", worktree: "path:/専用" } });
  const read = core.getSprintExecutionState(db, sprint.id);
  db.close();
  const action = read.nextActions.find(a => a.argv.includes("reconcile"))!;
  const shown = await runNod(["sprint", "execution", "show", sprint.id], { cwd, db: path });
  expect(shown.stdout).toContain(action.command);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const nod = join(dir, "nod");
  writeFileSync(nod, `#!/bin/sh\nexec bun ${quote(join(import.meta.dir, "../src/main.ts"))} "$@"\n`, { mode: 0o755 });
  // runNodのactorオプションを使わず、画面のcommand自身だけがNOD_ACTORを指定する。
  const env: Record<string, string | undefined> = { ...process.env, NOD_DB: path, NOD_ORCA: "0", PATH: `${dir}:${process.env.PATH}` };
  delete env.NOD_ACTOR; delete env.CLAUDECODE;
  const child = Bun.spawn(["/bin/sh", "-c", `${action.command} --json`], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).not.toContain("nod37_should_never_run: command not found");
  expect(exit).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ occupied: 1, reserved: 1, session: { actor: "codex", generation: 1 }, attempts: [{ reason: { code: "HOST_OBSERVATION_REQUIRED" } }] });
});
