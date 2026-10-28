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
else if(a[0]==='terminal')result={terminal:{handle:${JSON.stringify(terminal)},incarnationId:'incarnation',worktreePath:${JSON.stringify(cwd)},agentIdentity:'codex',connected:true}};
else if(a[1]==='send'){writeFileSync(${JSON.stringify(saved)},JSON.stringify({type:a[a.indexOf('--type')+1],from:a[a.indexOf('--from')+1],payload:JSON.parse(a[a.indexOf('--payload')+1])}));result={accepted:true,relay:{messageId:'実観測status',dispatchId:'dispatch',destination:'coordinator'},mutation:{requestId:'実送信request'}};}
else throw Error('想定外');console.log(JSON.stringify({ok:true,result,_meta:{runtimeId:'runtime'}}));`);
  const result = await runNod(["sprint", "worker", "observe", "sprint", "--run", "run", "--task", "task", "--dispatch", "dispatch", "--attempt", "attempt", "--confirmation", "新確認", "--dispatch-capability", "test-capability", "--json"], {
    cwd, db, env: { NOD_ORCA: "1", ORCA_CLI_COMMAND: `bun ${fake}`, CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111", ORCA_TERMINAL_HANDLE: terminal },
  });
  expect(result).toMatchObject({ exitCode: 0, json: { accepted: true, messageId: "実観測status", requestId: "実送信request" } });
  expect(JSON.parse(readFileSync(saved, "utf8"))).toMatchObject({ type: "status", from: terminal, payload: { kind: "nod.sprint.host-observation", taskId: "task", dispatchId: "dispatch", confirmationId: "新確認", metadata: { status: "unknown", model: null }, host: { identity: { runtimeId: "runtime", incarnationId: "incarnation", remoteRuntimeEpoch: null } } } });
  expect(existsSync(join(cwd, "非DB"))).toBe(false); expect(result.stdout).not.toContain("test-capability");
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
