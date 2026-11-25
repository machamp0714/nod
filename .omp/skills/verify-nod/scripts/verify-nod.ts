#!/usr/bin/env -S bun --no-env-file
// verify-nod の補助スクリプト。作業ツリーのソースの nod を、実行ごとの置き場と空いているポートで隔離して起動し、
// 状態確認（doctor）と後始末（cleanup）を行う。使い方は SKILL.md と `verify-nod.ts help` を見る。
//
// 守ること:
// - 利用者の nod（ポート 4700、~/.local/share/nod、~/.config/nod、~/Applications/nod.app）に触れない。4700 には接続しない
// - 検証の nod に渡す環境変数は nodEnv() の許可リストだけ。親の process.env を混ぜない
// - プロセスは名前で止めない。状態ファイルの PID のコマンドラインに自分の置き場のパスがあるときだけ止める
// - 後始末は作業用のデータとプロセスだけを消し、evidence/ を残す
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const USER_PORT = 4700;
const WORKTREE = resolve(import.meta.dir, "../../../..");
const CLI_MAIN = join(WORKTREE, "packages/cli/src/main.ts");
const WEB_PKG = join(WORKTREE, "packages/web");
const VITE_BIN = join(WEB_PKG, "node_modules/vite/bin/vite.js");
const BUN = process.execPath;
// gh（/opt/homebrew/bin、/usr/local/bin）が見つからず、git（/usr/bin/git）は使える最小の PATH
const SAFE_PATH = "/usr/bin:/bin";
const GIT = "/usr/bin/git";
const PS = "/bin/ps";
const LSOF = "/usr/sbin/lsof";
const DEFAULT_ACTOR = "verify-nod";
const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{5}$/;
const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

interface Layout {
  runDir: string;
  state: string;
  data: string;
  db: string;
  docs: string;
  attachments: string;
  home: string;
  tmp: string;
  config: string;
  togglConfig: string;
  ghUnavailable: string;
  viteEnv: string;
  repo: string;
  web: string;
  logs: string;
  uiStdout: string;
  uiStderr: string;
  evidence: string;
}

interface WorkspaceRef {
  key: string;
  name: string;
  path: string;
}

interface State {
  runId: string;
  runDir: string;
  worktree: string;
  createdAt: string;
  workspace: WorkspaceRef;
  argv: string[] | null;
  pid: number | null;
  url: string | null;
  port: number | null;
  dbPath: string;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

class Fail extends Error {}

function layout(runDir: string): Layout {
  const data = join(runDir, "data");
  const config = join(runDir, "config");
  const logs = join(runDir, "logs");
  return {
    runDir,
    state: join(runDir, "state.json"),
    data,
    db: join(data, "nod.db"),
    docs: join(data, "documents"),
    attachments: join(data, "attachments"),
    home: join(runDir, "home"),
    tmp: join(runDir, "tmp"),
    config,
    togglConfig: join(config, "toggl.json"), // 作らない（トークンを置かない）
    ghUnavailable: join(config, "gh-unavailable"), // 作らない（実行できない絶対パス）
    viteEnv: join(config, "vite-env"), // 空のまま（Vite に .env を読ませない）
    repo: join(runDir, "repo"),
    web: join(runDir, "web"),
    logs,
    uiStdout: join(logs, "ui.stdout.log"),
    uiStderr: join(logs, "ui.stderr.log"),
    evidence: join(runDir, "evidence"),
  };
}

// 検証の nod（server と CLI）に渡す環境変数の許可リスト。これ以外は渡さない
function nodEnv(p: Layout, actor = DEFAULT_ACTOR): Record<string, string> {
  return {
    PATH: SAFE_PATH,
    HOME: p.home,
    TMPDIR: p.tmp,
    NOD_DB: p.db,
    NOD_DOCS_DIR: p.docs,
    NOD_ATTACHMENTS_DIR: p.attachments,
    NOD_TOGGL_CONFIG: p.togglConfig,
    NOD_GH: p.ghUnavailable,
    NOD_ORCA: "0",
    TYPESAFE_API_KEY: "",
    NOD_ACTOR: actor,
  };
}

// web のビルドと git に渡す環境変数
function toolEnv(p: Layout): Record<string, string> {
  return { PATH: SAFE_PATH, HOME: p.home, TMPDIR: p.tmp, NOD_VITE_ENV_DIR: p.viteEnv };
}

// 存在する先祖まで realpath でたどり、シンボリックリンクを解いた絶対パスにする
function realish(path: string): string {
  let head = resolve(path);
  const rest: string[] = [];
  while (!existsSync(head)) {
    rest.unshift(basename(head));
    const up = dirname(head);
    if (up === head) break;
    head = up;
  }
  return join(realpathSync(head), ...rest);
}

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function forbiddenDirs(): string[] {
  const home = homedir();
  return [WORKTREE, join(home, ".local/share/nod"), join(home, ".config/nod"), join(home, "Applications/nod.app")];
}

function rootDir(): string {
  const raw = process.env.VERIFY_NOD_ROOT || join(homedir(), ".local/state/verify-nod");
  if (!isAbsolute(raw)) throw new Fail(`VERIFY_NOD_ROOT は絶対パスで指定してください: ${raw}`);
  const root = realish(raw);
  for (const dir of forbiddenDirs()) {
    if (within(root, realish(dir))) throw new Fail(`置き場の根 ${root} は ${dir} の中にあります。作業ツリーと利用者の nod のデータの外を指定してください`);
  }
  return root;
}

// 引数は run の ID（根の下）か、run のディレクトリの絶対パス
function resolveRun(ref: string | undefined): Layout {
  if (!ref) throw new Fail("run の ID かディレクトリを指定してください（launch の出力の runId / runDir）");
  const runDir = isAbsolute(ref) ? realish(ref) : join(rootDir(), ref);
  if (!RUN_ID_RE.test(basename(runDir))) throw new Fail(`${runDir} は verify-nod の run のディレクトリではありません（名前が run の ID の形でない）`);
  if (!existsSync(runDir)) {
    throw new Fail(`${runDir} がありません。runId で指定したときは VERIFY_NOD_ROOT が launch のときと同じか確かめるか、runDir の絶対パスを指定してください`);
  }
  if (!existsSync(join(runDir, "evidence"))) throw new Fail(`${runDir} は verify-nod の run のディレクトリではありません（evidence/ が無い）`);
  for (const dir of forbiddenDirs()) {
    if (within(runDir, realish(dir))) throw new Fail(`${runDir} は ${dir} の中にあります`);
  }
  return layout(runDir);
}

function readState(p: Layout): State | null {
  if (!existsSync(p.state)) return null;
  return JSON.parse(readFileSync(p.state, "utf8")) as State;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function exec(cmd: string[], opts: { cwd?: string; env: Record<string, string> }): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(cmd, { cwd: opts.cwd, env: opts.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

// ps / lsof は親の環境を使わず、固定の PATH で呼ぶ
const SYS_ENV = { PATH: SAFE_PATH + ":/usr/sbin:/sbin" };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return typeof e === "object" && e !== null && "code" in e && e.code === "EPERM";
  }
}

function commandLine(pid: number): string | null {
  const r = exec([PS, "-ww", "-o", "command=", "-p", String(pid)], { env: SYS_ENV });
  return r.code === 0 ? r.stdout.trim() : null;
}

function environmentLine(pid: number): string | null {
  const r = exec([PS, "eww", "-o", "command=", "-p", String(pid)], { env: SYS_ENV });
  return r.code === 0 ? r.stdout.trim() : null;
}

function listeners(port: number): number[] {
  const r = exec([LSOF, "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { env: SYS_ENV });
  return [...new Set(r.stdout.split("\n").filter(Boolean).map(Number))];
}

function ownsCommand(cmd: string | null, p: Layout): boolean {
  return cmd !== null && cmd.includes(CLI_MAIN) && cmd.includes(` ui `) && cmd.includes(p.web);
}

function readUiOutput(p: Layout): { url: string; reused: boolean; dbPath: string | null; webDir: string } | null {
  if (!existsSync(p.uiStdout)) return null;
  try {
    return JSON.parse(readFileSync(p.uiStdout, "utf8"));
  } catch {
    return null;
  }
}

function dbWorkspaces(dbPath: string): WorkspaceRef[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query("SELECT key, name, path FROM workspaces ORDER BY key").all() as WorkspaceRef[];
  } finally {
    db.close();
  }
}

function sameWorkspaces(a: WorkspaceRef[], b: WorkspaceRef[]): boolean {
  const norm = (l: WorkspaceRef[]) => JSON.stringify(l.map(({ key, name, path }) => ({ key, name, path })).sort((x, y) => x.key.localeCompare(y.key)));
  return norm(a) === norm(b);
}

async function doctorChecks(p: Layout, portOverride?: number): Promise<{ port: number | null; checks: Check[] }> {
  const checks: Check[] = [];
  const push = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const state = readState(p);
  if (!state) {
    push("state", false, `${p.state} がありません（launch 前か、後始末済み）`);
    return { port: null, checks };
  }
  if (state.pid === null || state.port === null || state.argv === null) {
    push("state", false, "状態ファイルに PID・ポートがありません（launch が途中で失敗した）");
    return { port: state.port, checks };
  }
  push("state", true, p.state);
  const port = portOverride ?? state.port;
  if (port === USER_PORT || state.port === USER_PORT) {
    push("port-not-user", false, `ポート ${USER_PORT} は利用者の nod のポートです。接続しません`);
    return { port, checks };
  }
  push("port-not-user", true, `ポート ${port}`);

  const alive = isAlive(state.pid);
  push("pid-alive", alive, alive ? `PID ${state.pid} は動いている` : `PID ${state.pid} は動いていません`);
  const cmd = alive ? commandLine(state.pid) : null;
  push("pid-command", ownsCommand(cmd, p), cmd ? `PID ${state.pid}: ${cmd}` : "コマンドラインを読めません");

  const expectedEnv = `${state.argv.join(" ")} ${Object.entries(nodEnv(p)).map(([k, v]) => `${k}=${v}`).join(" ")}`;
  const envLine = alive ? environmentLine(state.pid) : null;
  push("pid-env", envLine === expectedEnv, envLine === expectedEnv
    ? `環境変数は許可リストの ${Object.keys(nodEnv(p)).length} 項目だけ`
    : `環境変数が許可リストと一致しません。期待: ${expectedEnv} / 実際: ${envLine ?? "（読めない）"}`);

  const owners = listeners(port);
  push("port-owner", owners.length === 1 && owners[0] === state.pid,
    `ポート ${port} で LISTEN している PID: ${owners.join(",") || "（なし）"}、状態ファイルの PID: ${state.pid}`);

  const ui = readUiOutput(p);
  const uiOk = ui !== null && ui.reused === false && ui.dbPath === p.db && ui.url === `http://127.0.0.1:${state.port}/`;
  push("ui-output", uiOk, ui ? `nod ui の出力: reused=${ui.reused} dbPath=${ui.dbPath} url=${ui.url}` : `${p.uiStdout} を読めません`);

  let mine: WorkspaceRef[] = [];
  try {
    mine = dbWorkspaces(p.db);
    const has = mine.some((w) => w.key === state.workspace.key && w.path === state.workspace.path);
    push("db-workspace", has, `自分の DB ${p.db} の Workspace: ${mine.map((w) => w.key).join(",") || "（なし）"}（期待: ${state.workspace.key}）`);
  } catch (e) {
    push("db-workspace", false, `自分の DB を読み取り専用で開けません: ${e}`);
  }

  const origin = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${origin}/api/workspaces`, { signal: AbortSignal.timeout(3000) });
    const body = res.status === 200 ? ((await res.json()) as WorkspaceRef[]) : null;
    const ok = Array.isArray(body) && sameWorkspaces(body, mine) && body.some((w) => w.key === state.workspace.key);
    push("api-workspaces", ok, `${origin}/api/workspaces: ${res.status} ${Array.isArray(body) ? body.map((w) => `${w.key}(${w.path})`).join(",") : ""}`
      + (ok ? "（自分の DB と一致）" : "（自分の DB の Workspace と一致しません。別の nod につながっている）"));
  } catch (e) {
    push("api-workspaces", false, `${origin}/api/workspaces に接続できません: ${e}`);
  }
  try {
    const res = await fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) });
    const html = await res.text();
    const built = existsSync(join(p.web, "index.html")) ? readFileSync(join(p.web, "index.html"), "utf8") : null;
    const ok = res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/html") && html === built;
    push("web-html", ok, `${origin}/: ${res.status} ${res.headers.get("content-type") ?? ""}` + (html === built ? "（この run でビルドした index.html と同じ）" : "（この run でビルドした index.html と違う）"));
  } catch (e) {
    push("web-html", false, `${origin}/ に接続できません: ${e}`);
  }
  return { port, checks };
}

function stamp(d = new Date()): string {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

function newRun(): { runId: string; key: string } {
  const hex = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 5);
  return { runId: `${stamp()}-${hex}`, key: `V${hex.toUpperCase()}` };
}

function tail(path: string, lines = 20): string {
  if (!existsSync(path)) return "（なし）";
  return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n") || "（空）";
}

async function launch(): Promise<number> {
  const root = rootDir();
  mkdirSync(root, { recursive: true });
  const { runId, key } = newRun();
  const p = layout(join(root, runId));
  mkdirSync(p.runDir); // 既にあれば失敗させる（別の run と混ざらない）
  for (const dir of [p.data, p.docs, p.attachments, p.home, p.tmp, p.config, p.viteEnv, p.repo, p.web, p.logs, p.evidence]) mkdirSync(dir, { recursive: true });
  const repoPath = realpathSync(p.repo);
  const state: State = {
    runId,
    runDir: p.runDir,
    worktree: WORKTREE,
    createdAt: new Date().toISOString(),
    workspace: { key, name: `verify-nod-${runId}`, path: repoPath },
    argv: null,
    pid: null,
    url: null,
    port: null,
    dbPath: p.db,
  };
  writeJson(p.state, state);
  const log = (msg: string) => process.stderr.write(`verify-nod: ${msg}\n`);
  let proc: Subprocess | null = null;
  try {
    log(`run ${p.runDir}`);
    log("web をビルドしています（vite build）");
    const build = exec([BUN, "--no-env-file", VITE_BIN, "build", "--outDir", p.web, "--emptyOutDir"], { cwd: WEB_PKG, env: toolEnv(p) });
    writeFileSync(join(p.logs, "web-build.log"), build.stdout + build.stderr);
    if (build.code !== 0 || !existsSync(join(p.web, "index.html"))) throw new Fail(`web のビルドに失敗しました（${join(p.logs, "web-build.log")}）\n${tail(join(p.logs, "web-build.log"))}`);

    const git = exec([GIT, "init", "-q", p.repo], { env: toolEnv(p) });
    if (git.code !== 0) throw new Fail(`git init に失敗しました: ${git.stderr}`);
    const init = exec([BUN, "--no-env-file", CLI_MAIN, "--json", "init", "--key", key, "--name", state.workspace.name], { cwd: p.repo, env: nodEnv(p) });
    writeFileSync(join(p.logs, "init.log"), init.stdout + init.stderr);
    if (init.code !== 0) throw new Fail(`nod init に失敗しました: ${init.stdout}${init.stderr}`);
    const created = JSON.parse(init.stdout) as { created: boolean; workspace: WorkspaceRef };
    if (!created.created || created.workspace.key !== key || created.workspace.path !== repoPath) throw new Fail(`nod init の結果が期待と違います: ${init.stdout}`);

    log("nod ui を起動しています");
    const argv = [BUN, "--no-env-file", CLI_MAIN, "--json", "ui", "--port", "0", "--no-open", "--web-dir", p.web];
    proc = Bun.spawn(argv, {
      cwd: p.home,
      env: nodEnv(p),
      stdin: "ignore",
      stdout: Bun.file(p.uiStdout),
      stderr: Bun.file(p.uiStderr),
      detached: true, // 補助スクリプトの終了や端末の Ctrl+C で止まらないよう、別のプロセスグループで動かす
    });
    proc.unref();
    state.argv = argv;
    state.pid = proc.pid;
    writeJson(p.state, state);

    const deadline = Date.now() + READY_TIMEOUT_MS;
    let ui = readUiOutput(p);
    while (!ui) {
      if (proc.exitCode !== null) throw new Fail(`nod ui が終了しました（終了コード ${proc.exitCode}）\n${tail(p.uiStderr)}`);
      if (Date.now() > deadline) throw new Fail(`nod ui の出力が ${READY_TIMEOUT_MS / 1000} 秒以内に得られませんでした\n${tail(p.uiStderr)}`);
      await Bun.sleep(200);
      ui = readUiOutput(p);
    }
    const port = Number(new URL(ui.url).port);
    if (port === USER_PORT) throw new Fail(`nod ui がポート ${USER_PORT} で起動しました。利用者の nod のポートなので使いません`);
    if (ui.reused !== false) throw new Fail(`nod ui が既存の nod を再利用しました（reused=${ui.reused}）`);
    state.url = ui.url;
    state.port = port;
    writeJson(p.state, state);

    const { checks } = await doctorChecks(p);
    const ok = checks.every((c) => c.ok);
    const summary = { ok, runId, runDir: p.runDir, url: state.url, port, pid: state.pid, dbPath: p.db, workspace: state.workspace, evidence: p.evidence, checks };
    writeJson(join(p.evidence, "launch.json"), { state, ui, checks });
    if (!ok) throw new Fail(`起動後の状態確認が通りません\n${JSON.stringify(checks.filter((c) => !c.ok), null, 2)}`);
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  } catch (e) {
    if (proc && proc.exitCode === null) {
      proc.kill("SIGTERM");
      await Promise.race([proc.exited, Bun.sleep(STOP_TIMEOUT_MS)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
    log(`起動に失敗しました。起動した nod ui は止めました。ログを読んだら cleanup ${p.runDir} で作業用のデータを消してください`);
    throw e;
  }
}

async function doctor(args: string[]): Promise<number> {
  const portIdx = args.indexOf("--port");
  let portOverride: number | undefined;
  if (portIdx >= 0) {
    portOverride = Number(args[portIdx + 1]);
    if (!Number.isInteger(portOverride) || portOverride <= 0) throw new Fail(`--port の値が正しくありません: ${args[portIdx + 1]}`);
    if (portOverride === USER_PORT) throw new Fail(`ポート ${USER_PORT} は利用者の nod のポートです。指定できません`);
    args = args.filter((_, i) => i !== portIdx && i !== portIdx + 1);
  }
  const p = resolveRun(args[0]);
  const { port, checks } = await doctorChecks(p, portOverride);
  const ok = checks.length > 0 && checks.every((c) => c.ok);
  console.log(JSON.stringify({ ok, runDir: p.runDir, port, checks }, null, 2));
  if (!ok) for (const c of checks.filter((c) => !c.ok)) process.stderr.write(`NG ${c.name}: ${c.detail}\n`);
  return ok ? 0 : 1;
}

async function stopOwned(state: State | null, p: Layout): Promise<{ pid: number | null; result: string }> {
  if (!state?.pid) return { pid: null, result: "起動したプロセスの記録なし" };
  const pid = state.pid;
  if (!isAlive(pid)) return { pid, result: "停止済み" };
  const cmd = commandLine(pid);
  if (!ownsCommand(cmd, p)) {
    throw new Fail(`PID ${pid} のコマンドラインにこの run の置き場がありません。別のプロセスなので止めません: ${cmd ?? "（読めない）"}`);
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(100);
  if (isAlive(pid) && ownsCommand(commandLine(pid), p)) {
    process.kill(pid, "SIGKILL");
    await Bun.sleep(300);
  }
  if (isAlive(pid)) throw new Fail(`PID ${pid} を止められませんでした`);
  return { pid, result: "SIGTERM で停止" };
}

async function cleanup(args: string[]): Promise<number> {
  const p = resolveRun(args[0]);
  const state = readState(p);
  const stopped = await stopOwned(state, p);
  // evidence/ は消さない
  const removed = [p.data, p.home, p.tmp, p.config, p.repo, p.web, p.logs, p.state].filter((path) => existsSync(path));
  for (const path of removed) rmSync(path, { recursive: true, force: true });
  const recordPath = join(p.evidence, "cleanup.json");
  const record = existsSync(recordPath) ? (JSON.parse(readFileSync(recordPath, "utf8")) as unknown[]) : [];
  record.push({ at: new Date().toISOString(), stopped, removed });
  writeJson(recordPath, record);
  const left = readdirSync(p.runDir);
  console.log(JSON.stringify({ ok: true, runDir: p.runDir, stopped, removed, left, evidence: p.evidence }, null, 2));
  return 0;
}

function list(): number {
  const root = rootDir();
  const runs = existsSync(root)
    ? readdirSync(root).filter((n) => RUN_ID_RE.test(n) && statSync(join(root, n)).isDirectory()).sort().map((runId) => {
      const p = layout(join(root, runId));
      const state = readState(p);
      return {
        runId,
        runDir: p.runDir,
        cleaned: state === null && !existsSync(p.data),
        pid: state?.pid ?? null,
        alive: state?.pid ? isAlive(state.pid) && ownsCommand(commandLine(state.pid), p) : false,
        url: state?.url ?? null,
      };
    })
    : [];
  console.log(JSON.stringify({ root, runs }, null, 2));
  return 0;
}

// 検証の nod と同じデータで、ソースの CLI を実行する。cwd は run の repo（Workspace として登録済み）
function cli(args: string[]): number {
  const sep = args.indexOf("--");
  if (sep < 0) throw new Fail("cli <run> [--actor <名前>] -- <nod の引数...> の形で指定してください");
  const own = args.slice(0, sep);
  const nodArgs = args.slice(sep + 1);
  const actorIdx = own.indexOf("--actor");
  let actor = DEFAULT_ACTOR;
  if (actorIdx >= 0) {
    const value = own[actorIdx + 1];
    if (!value) throw new Fail("--actor の値がありません");
    actor = value;
    own.splice(actorIdx, 2);
  }
  const p = resolveRun(own[0]);
  if (!existsSync(p.db)) throw new Fail(`${p.db} がありません（後始末済み）`);
  const r = Bun.spawnSync([BUN, "--no-env-file", CLI_MAIN, ...nodArgs], { cwd: p.repo, env: nodEnv(p, actor), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return r.exitCode ?? 1;
}

const HELP = `verify-nod.ts <サブコマンド>
  launch                         空の置き場に run を作り、web をビルドし、Workspace を登録して nod ui を起動する
  doctor <run> [--port <番号>]   読み取りだけの状態確認（--port で照合先のポートを変える。4700 は拒む）
  cli <run> [--actor <名前>] -- <nod の引数...>  検証の nod と同じデータでソースの CLI を実行する
  cleanup <run>                  自分が起動したプロセスと作業用のデータを消す（evidence/ は残す。何度実行してもよい）
  list                           置き場の根にある run の一覧
<run> は launch の出力の runId（根の下）か runDir（絶対パス）。根は VERIFY_NOD_ROOT（既定 ~/.local/state/verify-nod）`;

async function main(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "launch":
      return launch();
    case "doctor":
      return doctor(rest);
    case "cli":
      return cli(rest);
    case "cleanup":
      return cleanup(rest);
    case "list":
      return list();
    case "help":
    case "--help":
    case undefined:
      console.log(HELP);
      return sub === undefined ? 1 : 0;
    default:
      throw new Fail(`不明なサブコマンド: ${sub}\n${HELP}`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`verify-nod: ${e instanceof Fail ? e.message : e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
}
