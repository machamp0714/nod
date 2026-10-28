import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNod, tempDir } from "./helpers";

test("worker自己観測CLIはDBを開かず、未知identityを要求設定で補わない", async () => {
  const cwd = tempDir(), db = join(cwd, "存在しない親", "nod.db");
  const result = await runNod(["sprint", "worker", "collect", "--json"], { cwd, db, env: { CODEX_THREAD_ID: "", ORCA_TERMINAL_HANDLE: "" } });
  expect(result).toMatchObject({ exitCode: 0, json: { status: "unknown", model: null, effort: null } });
  expect(existsSync(join(cwd, "存在しない親"))).toBe(false);
  const arbitrary = await runNod(["sprint", "worker", "collect", "--path", "/任意thread", "--json"], { cwd, db });
  expect(arbitrary).toMatchObject({ exitCode: 1, json: { error: { code: "INVALID_ARGS" } } });
});

test("worker観測送信はOrca statusだけを送りDBを開かず、capabilityを結果へ含めない", async () => {
  const cwd = tempDir(), db = join(cwd, "非DB", "nod.db"), fake = join(cwd, "orca.ts"), saved = join(cwd, "status.json");
  const terminal = "term_11111111-1111-4111-8111-111111111111";
  writeFileSync(fake, `import {writeFileSync} from 'node:fs';const a=process.argv.slice(2);let result;
if(a[0]==='status')result={runtime:{runtimeId:'runtime',reachable:true}};
else if(a[1]==='check')result={runId:'run',dispatchId:'dispatch',messages:[],count:0,acknowledged:null};
else if(a[0]==='terminal')result={terminal:{handle:${JSON.stringify(terminal)},incarnationId:'incarnation',worktreePath:${JSON.stringify(cwd)},agentIdentity:'codex',connected:true}};
else if(a[1]==='send'){writeFileSync(${JSON.stringify(saved)},JSON.stringify({hasExplicitRun:a.includes('--run'),hasExplicitTo:a.includes('--to'),type:a[a.indexOf('--type')+1],from:a[a.indexOf('--from')+1],payload:JSON.parse(a[a.indexOf('--payload')+1])}));result={relay:{messageId:'実観測status',sequence:1,dispatchId:'dispatch',destination:'run_home',accepted:true},mutation:{requestId:'実送信request'}};}
else throw Error('想定外');console.log(JSON.stringify({ok:true,result,_meta:{runtimeId:'runtime'}}));`);
  const result = await runNod(["sprint", "worker", "observe", "sprint", "--run", "run", "--task", "task", "--dispatch", "dispatch", "--attempt", "attempt", "--confirmation", "新確認", "--dispatch-capability", "test-capability", "--json"], {
    cwd, db, env: { NOD_ORCA: "1", ORCA_CLI_COMMAND: `bun ${fake}`, CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111", ORCA_TERMINAL_HANDLE: terminal },
  });
  expect(result).toMatchObject({ exitCode: 0, json: { accepted: true, messageId: "実観測status", requestId: "実送信request" } });
  expect(JSON.parse(readFileSync(saved, "utf8"))).toMatchObject({ hasExplicitRun: false, hasExplicitTo: false, type: "status", from: terminal, payload: { kind: "nod.sprint.host-observation", taskId: "task", dispatchId: "dispatch", confirmationId: "新確認", metadata: { status: "unknown", model: null }, host: { identity: { runtimeId: "runtime", incarnationId: "incarnation", remoteRuntimeEpoch: null } } } });
  expect(existsSync(join(cwd, "非DB"))).toBe(false); expect(result.stdout).not.toContain("test-capability");
});

test("観測CLIは正式directの送信元・Run・宛先・通知を照合し明示accepted互換を保つ", async () => {
  const cases = [
    { patch: {}, accepted: true }, { patch: {}, top: true, accepted: true },
    { patch: {}, top: false, accepted: false }, { patch: { id: null }, accepted: false },
    { patch: { run_id: "other" }, accepted: false }, { patch: { from_handle: "dispatch:dispatch" }, accepted: false },
    { patch: { to_handle: "dispatch:dispatch" }, accepted: false }, { patch: { type: "rejection" }, accepted: false },
    { patch: { payload: "{}" }, accepted: false }, { patch: {}, rejected: true, accepted: false },
  ];
  for (const fixture of cases) {
    const cwd = tempDir(), db = join(cwd, "no-db", "nod.db"), fake = join(cwd, "orca.ts"), calls = join(cwd, "calls.txt");
    // 正式directはJSON文字列payloadをそのまま保存して返す。ID/宛先等は固定wire。
    writeFileSync(fake, `import {appendFileSync} from 'node:fs';const a=process.argv.slice(2);if(a[1]==='send'){appendFileSync(${JSON.stringify(calls)},'send\\n');if(a.includes('--run')||a.includes('--to'))throw Error('remote contract');const result={message:{id:'direct_observation',run_id:'run',from_handle:'term_11111111-1111-4111-8111-111111111111',to_handle:'run:run',type:'status',payload:a[a.indexOf('--payload')+1],...${JSON.stringify(fixture.patch)}},mutation:{requestId:'direct_request'},...${JSON.stringify(fixture.top === undefined ? {} : { accepted: fixture.top })},...${JSON.stringify(fixture.rejected ? { lifecycle: { action: "rejected" } } : {})}};console.log(JSON.stringify({ok:true,result}));}else console.log(JSON.stringify({ok:true,result:a[1]==='check'?{runId:'run',dispatchId:'dispatch',messages:[],count:0,acknowledged:null}:{}}));`);
    const observed = await runNod(["sprint", "worker", "observe", "sprint", "--run", "run", "--task", "task", "--dispatch", "dispatch", "--attempt", "attempt", "--dispatch-capability", "private-capability", "--json"], {
      cwd, db, env: { NOD_ORCA: "1", ORCA_CLI_COMMAND: `bun ${fake}`, CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111", ORCA_TERMINAL_HANDLE: "term_11111111-1111-4111-8111-111111111111" },
    });
    expect(observed.json).toMatchObject({ accepted: fixture.accepted, requestId: "direct_request" });
    if (fixture.accepted) expect(observed.json.messageId).toBe("direct_observation");
    expect(readFileSync(calls, "utf8")).toBe("send\n");
    expect(existsSync(join(cwd, "no-db"))).toBe(false);
    expect(observed.stdout).not.toContain("private-capability");
  }
});

test("観測relayの不完全・拒否・別Dispatch・宛先違い・失敗exitはrequestを保持して再送しない", async () => {
  const relay = { messageId: "relay_observation", sequence: 1, dispatchId: "dispatch", destination: "run_home", accepted: true };
  const cases = [
    { relay: { ...relay, accepted: undefined }, accepted: true }, { relay: { ...relay, accepted: false }, accepted: true },
    { relay: { ...relay, messageId: undefined } }, { relay: { ...relay, dispatchId: undefined } },
    { relay: { ...relay, dispatchId: "other" } }, { relay: { ...relay, destination: "worker" } },
    { relay: { ...relay, destination: "coordinator" } }, { relay, accepted: false },
    { relay, lifecycle: { action: "rejected" } },
  ];
  for (const [index, result] of [...cases, { relay }, { relay }].entries()) {
    const cwd = tempDir(), db = join(cwd, "no-db", "nod.db"), fake = join(cwd, "orca.ts"), calls = join(cwd, "calls.txt");
    const wire = { ok: index !== cases.length, result: { ...result, mutation: { requestId: "original_request" } } };
    writeFileSync(fake, `import {appendFileSync} from 'node:fs';const a=process.argv.slice(2);if(a[1]==='send'){appendFileSync(${JSON.stringify(calls)},'send\\n');console.log(${JSON.stringify(JSON.stringify(wire))});process.exit(${index === cases.length + 1 ? 7 : 0});}console.log(JSON.stringify({ok:true,result:a[1]==='check'?{runId:'run',dispatchId:'dispatch',messages:[],count:0,acknowledged:null}:{}}));`);
    const observed = await runNod(["sprint", "worker", "observe", "sprint", "--run", "run", "--task", "task", "--dispatch", "dispatch", "--attempt", "attempt", "--dispatch-capability", "private-capability", "--json"], {
      cwd, db, env: { NOD_ORCA: "1", ORCA_CLI_COMMAND: `bun ${fake}`, CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111", ORCA_TERMINAL_HANDLE: "term_11111111-1111-4111-8111-111111111111" },
    });
    expect(observed.json).toMatchObject({ accepted: false, requestId: "original_request" });
    expect(readFileSync(calls, "utf8")).toBe("send\n");
    expect(existsSync(join(cwd, "no-db"))).toBe(false);
    expect(Object.keys(observed.json).sort()).toEqual(["accepted", "binding", "messageId", "metadataStatus", "observationId", "receivedAt", "requestId", "source"]);
    expect(observed.stdout).not.toContain("private-capability");
  }
});

function syntheticProviderState(cwd: string) {
  const codexRoot = join(cwd, "synthetic-codex-state"), dir = join(codexRoot, "sessions", "2026", "10", "28");
  mkdirSync(dir, { recursive: true });
  const thread = "33333333-3333-4333-8333-333333333333", turn = "55555555-5555-4555-8555-555555555555";
  const terminal = "term_44444444-4444-4444-8444-444444444444", at = "2026-10-28T00:00:00.000Z";
  const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: at, type, payload }) + "\n";
  const text = line("session_meta", { id: thread, cwd, cli_version: "0.164.0", originator: "codex-tui", source: "cli", model_provider: "fixture-provider" })
    + line("event_msg", { type: "task_started", turn_id: turn })
    + line("turn_context", { turn_id: turn, cwd, model: "fixture-model", effort: "high" })
    + line("event_msg", { type: "thread_settings_applied", thread_id: thread, thread_settings: { cwd, model: "fixture-model", reasoning_effort: "high", model_provider_id: "fixture-provider" } })
    + line("token_usage_record", { thread_id: thread, turn_id: turn, session_id: thread, root_turn_id: turn });
  const file = join(dir, `rollout-2026-10-28T00-00-00-${thread}.jsonl`); writeFileSync(file, text);
  return { codexRoot, file, text, env: { CODEX_HOME: codexRoot, CODEX_THREAD_ID: thread, ORCA_TERMINAL_HANDLE: terminal }, thread, turn, terminal };
}

test("worker collectはchild専用CODEX_HOMEの自己metadataだけを観測し通常DBを生成しない", async () => {
  const cwd = tempDir(), db = join(cwd, "no-db", "nod.db"), fixture = syntheticProviderState(cwd);
  const result = await runNod(["sprint", "worker", "collect", "--json"], { cwd, db, env: fixture.env });
  expect(result).toMatchObject({ exitCode: 0, json: { status: "observed", threadId: fixture.thread, turnId: fixture.turn, terminal: fixture.terminal, cwd,
    model: "fixture-model", effort: "high", provider: "fixture-provider", cliVersion: "0.164.0" } });
  expect(existsSync(join(cwd, "no-db"))).toBe(false);
});

test("指定CODEX_HOMEの自己metadataが欠測や無効なら別rootや他threadを採用しない", async () => {
  const cwd = tempDir(), db = join(cwd, "no-db", "nod.db"), fixture = syntheticProviderState(cwd);
  const otherThread = "66666666-6666-4666-8666-666666666666";
  writeFileSync(fixture.file.replace(fixture.thread, otherThread), fixture.text.replaceAll(fixture.thread, otherThread));
  unlinkSync(fixture.file);
  const missing = await runNod(["sprint", "worker", "collect", "--json"], { cwd, db, env: fixture.env });
  expect(missing).toMatchObject({ exitCode: 0, json: { status: "unknown", model: null, reasons: ["unique_self_file_required"] } });
  writeFileSync(fixture.file, fixture.text.replace('"cwd":'+JSON.stringify(cwd), '"cwd":"/synthetic-wrong-cwd"'));
  const invalid = await runNod(["sprint", "worker", "collect", "--json"], { cwd, db, env: fixture.env });
  expect(invalid).toMatchObject({ exitCode: 0, json: { status: "unknown", model: null, reasons: ["session_header_identity_mismatch"] } });
  writeFileSync(fixture.file, fixture.text.slice(0, -1));
  const incomplete = await runNod(["sprint", "worker", "collect", "--json"], { cwd, db, env: fixture.env });
  expect(incomplete.json.status).toBe("unknown"); expect(incomplete.json.reasons).toContain("snapshot_incomplete");
  const unavailable = join(cwd, "missing-configured-root");
  const noRoot = await runNod(["sprint", "worker", "collect", "--json"], { cwd, db, env: { ...fixture.env, CODEX_HOME: unavailable } });
  expect(noRoot).toMatchObject({ exitCode: 0, json: { status: "unknown", model: null } });
  expect(existsSync(unavailable)).toBe(false); expect(existsSync(join(cwd, "no-db"))).toBe(false);
});


test("実remote契約では自己peekの同Run/Dispatchを確認しto/runなしで一回だけ送る", async () => {
  const cwd = tempDir(), db = join(cwd, "no-db", "nod.db"), fake = join(cwd, "orca.ts"), calls = join(cwd, "calls.txt");
  writeFileSync(fake, `import {appendFileSync} from 'node:fs';const a=process.argv.slice(2);let result={};
if(a[1]==='check'){if(!a.includes('--peek')||a.includes('--ack')||a.includes('--wait')||a.includes('--run'))throw Error('peek contract');appendFileSync(${JSON.stringify(calls)},'peek'+String.fromCharCode(10));result={runId:'run',dispatchId:'dispatch',messages:[],count:0,acknowledged:null};}
else if(a[1]==='send'){appendFileSync(${JSON.stringify(calls)},'send'+String.fromCharCode(10));if(a.includes('--run')||a.includes('--to'))throw Error('Federated Dispatch messages route to their Run home; omit --to and --run.');result={relay:{messageId:'relay_bound',sequence:1,dispatchId:'dispatch',destination:'run_home',accepted:true},mutation:{requestId:'bound_request'}};}
console.log(JSON.stringify({ok:true,result}));`);
  const observed = await runNod(["sprint", "worker", "observe", "sprint", "--run", "run", "--task", "task", "--dispatch", "dispatch", "--attempt", "attempt", "--dispatch-capability", "private-capability", "--json"], {
    cwd, db, env: { NOD_ORCA: "1", ORCA_CLI_COMMAND: `bun ${fake}`, CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111", ORCA_TERMINAL_HANDLE: "term_11111111-1111-4111-8111-111111111111" },
  });
  expect(observed.json).toMatchObject({ accepted: true, messageId: "relay_bound", requestId: "bound_request", binding: { runId: "run", dispatchId: "dispatch" } });
  expect(readFileSync(calls, "utf8")).toBe("peek\nsend\n");
  expect(existsSync(join(cwd, "no-db"))).toBe(false);
});


test("自己peekのRun/Dispatch不一致・欠測・失敗ではsendせずraw受信箱を出さない", async () => {
  const cases = [
    { result: { runId: "other", dispatchId: "dispatch" } }, { result: { runId: "run", dispatchId: "other" } },
    { result: { runId: "run" } }, { result: { dispatchId: "dispatch" } },
    { result: { runId: "run", dispatchId: "dispatch" }, ok: false },
    { result: { runId: "run", dispatchId: "dispatch" }, exit: 7 }, { result: {}, malformed: true },
  ];
  for (const fixture of cases) {
    const cwd = tempDir(), db = join(cwd, "no-db", "nod.db"), fake = join(cwd, "orca.ts"), calls = join(cwd, "calls.txt");
    const wire = { ok: fixture.ok ?? true, result: { ...fixture.result, messages: [{ body: "private-inbox-body", payload: "private-inbox-payload" }], count: 1, acknowledged: null } };
    writeFileSync(fake, `import {appendFileSync} from 'node:fs';const a=process.argv.slice(2);if(a[1]==='send'){appendFileSync(${JSON.stringify(calls)},'send');throw Error('must not send');}if(a[1]==='check'){if(!a.includes('--peek')||a.includes('--run')||a.includes('--wait')||a.includes('--ack'))throw Error('peek contract');appendFileSync(${JSON.stringify(calls)},'peek');console.log(${JSON.stringify(fixture.malformed ? "invalid JSON" : JSON.stringify(wire))});process.exit(${fixture.exit ?? 0});}console.log(JSON.stringify({ok:true,result:{}}));`);
    const observed = await runNod(["sprint", "worker", "observe", "sprint", "--run", "run", "--task", "task", "--dispatch", "dispatch", "--attempt", "attempt", "--dispatch-capability", "private-capability", "--json"], {
      cwd, db, env: { NOD_ORCA: "1", ORCA_CLI_COMMAND: `bun ${fake}`, CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111", ORCA_TERMINAL_HANDLE: "term_11111111-1111-4111-8111-111111111111" },
    });
    expect(observed.json).toMatchObject({ accepted: false, messageId: null, requestId: null });
    expect(readFileSync(calls, "utf8")).toBe("peek");
    expect(existsSync(join(cwd, "no-db"))).toBe(false);
    expect(observed.stdout).not.toContain("private-inbox"); expect(observed.stdout).not.toContain("private-capability");
    expect(Object.keys(observed.json).sort()).toEqual(["accepted", "binding", "messageId", "metadataStatus", "observationId", "receivedAt", "requestId", "source"]);
  }
});
