#!/usr/bin/env -S bun --no-env-file
// verify-nod の補助スクリプト。作業ツリーのソースの nod を、実行ごとの置き場と空いているポートで隔離して起動し、
// 状態確認（doctor）、CLI・Web の操作と証拠の保存（cli・browser）、後始末（cleanup）を行う。使い方は SKILL.md と `verify-nod.ts help` を見る。
//
// 守ること:
// - 利用者の nod（ポート 4700、~/.local/share/nod、~/.config/nod、~/Applications/nod.app）に触れない。4700 には接続しない
// - 検証の nod に渡す環境変数は nodEnv() の許可リストだけ。親の process.env を混ぜない
// - ブラウザは新しいコンテキストで開き、その run の origin 以外への要求をブラウザ側で止める
// - プロセスは名前で止めない。状態ファイルの PID のコマンドラインに自分の置き場のパスがあるときだけ止める
// - 後始末は作業用のデータとプロセスだけを消し、evidence/ を残す
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
// 型だけ。実行時は packages/web から解決して読み込む（loadPlaywright）
import type { Browser, Locator, Page } from "../../../../packages/web/node_modules/@playwright/test";
import type * as PlaywrightModule from "../../../../packages/web/node_modules/@playwright/test";

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

// browser が起動したブラウザのうち残っているもの。--user-data-dir がこの run の tmp/ の下にあるプロセスだけを数える
function browserProcesses(p: Layout): number[] {
  const r = exec([PS, "-ax", "-ww", "-o", "pid=,command="], { env: SYS_ENV });
  const marker = `--user-data-dir=${p.tmp}/`;
  return r.stdout.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m?.[1] && m[2]?.includes(marker) ? [Number(m[1])] : [];
  });
}

async function stopBrowsers(p: Layout): Promise<number[]> {
  const pids = browserProcesses(p);
  for (const pid of pids) process.kill(pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (browserProcesses(p).length > 0 && Date.now() < deadline) await Bun.sleep(100);
  for (const pid of browserProcesses(p)) process.kill(pid, "SIGKILL");
  return pids;
}

async function cleanup(args: string[]): Promise<number> {
  const p = resolveRun(args[0]);
  const state = readState(p);
  const browsers = await stopBrowsers(p);
  const stopped = await stopOwned(state, p);
  // evidence/ は消さない
  const removed = [p.data, p.home, p.tmp, p.config, p.repo, p.web, p.logs, p.state].filter((path) => existsSync(path));
  for (const path of removed) rmSync(path, { recursive: true, force: true });
  const recordPath = join(p.evidence, "cleanup.json");
  const record = existsSync(recordPath) ? (JSON.parse(readFileSync(recordPath, "utf8")) as unknown[]) : [];
  record.push({ at: new Date().toISOString(), stopped, browsers, removed });
  writeJson(recordPath, record);
  const left = readdirSync(p.runDir);
  console.log(JSON.stringify({ ok: true, runDir: p.runDir, stopped, browsers, removed, left, evidence: p.evidence }, null, 2));
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

// 証拠の置き場は <run>/evidence/<機能の ID>/。ファイル名の先頭の3桁は、その置き場での呼び出しごとの通し番号
const FEATURE_RE = /^[a-z0-9][a-z0-9-]*$/;

function featureEvidence(p: Layout, feature: string | undefined): { dir: string; seq: string } {
  if (!feature || !FEATURE_RE.test(feature)) throw new Fail(`機能の ID が正しくありません: ${feature ?? "（なし）"}（英小文字・数字・ハイフン。例 issue-create）`);
  const dir = join(p.evidence, feature);
  mkdirSync(dir, { recursive: true });
  const used = readdirSync(dir).flatMap((n) => {
    const m = /^(\d{3})-/.exec(n);
    return m?.[1] ? [Number(m[1])] : [];
  });
  return { dir, seq: String(Math.max(0, ...used) + 1).padStart(3, "0") };
}

// args から「名前 値」を取り除いて値を返す
function takeOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Fail(`${name} の値がありません`);
  args.splice(i, 2);
  return value;
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ソースの CLI を、その run と同じデータ・許可リストの環境で実行し、標準出力・標準エラーを受け取る。cwd は run の repo（Workspace として登録済み）
async function runCli(p: Layout, actor: string, nodArgs: string[], stdin: "inherit" | "ignore"): Promise<CliResult> {
  const proc = Bun.spawn([BUN, "--no-env-file", CLI_MAIN, ...nodArgs], { cwd: p.repo, env: nodEnv(p, actor), stdin, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

// CLI の呼び出しの記録（cli --evidence の <番号>-cli.json と、browser の cli の手順の <番号>-<手順>-cli.json）
function writeCliEvidence(p: Layout, file: string, feature: string, actor: string, nodArgs: string[], r: CliResult, startedAt: string): void {
  let stdoutJson: unknown;
  try {
    stdoutJson = JSON.parse(r.stdout);
  } catch {
    stdoutJson = undefined;
  }
  const state = readState(p);
  writeJson(file, {
    kind: "cli",
    feature,
    runId: state?.runId ?? basename(p.runDir),
    runDir: p.runDir,
    url: state?.url ?? null,
    actor,
    cwd: p.repo,
    command: ["nod", ...nodArgs],
    exitCode: r.exitCode,
    startedAt,
    finishedAt: new Date().toISOString(),
    stdout: r.stdout,
    stderr: r.stderr,
    ...(stdoutJson === undefined ? {} : { stdoutJson }),
  });
}

// 検証の nod と同じデータで、ソースの CLI を実行する。
// --evidence <機能の ID> を付けると、コマンド・標準出力・標準エラー・終了コードを evidence/<機能の ID>/<番号>-cli.json に残す
async function cli(args: string[]): Promise<number> {
  const sep = args.indexOf("--");
  if (sep < 0) throw new Fail("cli <run> [--actor <名前>] [--evidence <機能の ID>] -- <nod の引数...> の形で指定してください");
  const own = args.slice(0, sep);
  const nodArgs = args.slice(sep + 1);
  const actor = takeOption(own, "--actor") ?? DEFAULT_ACTOR;
  const feature = takeOption(own, "--evidence");
  if (own.length !== 1) throw new Fail(`cli の引数が正しくありません: ${own.join(" ")}`);
  const p = resolveRun(own[0]);
  if (!existsSync(p.db)) throw new Fail(`${p.db} がありません（後始末済み）`);
  if (feature === undefined) {
    const r = Bun.spawnSync([BUN, "--no-env-file", CLI_MAIN, ...nodArgs], { cwd: p.repo, env: nodEnv(p, actor), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return r.exitCode ?? 1;
  }
  const { dir, seq } = featureEvidence(p, feature);
  const startedAt = new Date().toISOString();
  const r = await runCli(p, actor, nodArgs, "inherit");
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  const file = join(dir, `${seq}-cli.json`);
  writeCliEvidence(p, file, feature, actor, nodArgs, r, startedAt);
  process.stderr.write(`verify-nod: 証拠 ${file}\n`);
  return r.exitCode;
}

// ---- browser: Playwright で Web を操作し、ARIA スナップショットとスクリーンショットを残す ----

const BROWSER_TIMEOUT_MS = 10_000;
const VIEWPORT = { width: 1440, height: 960 };
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// 手順の操作（1つの手順にこのキーを1つだけ書く）と、その操作に添えてよいキー
const OPS = {
  goto: [],
  reload: [],
  url: [],
  click: [],
  fill: ["value"],
  press: ["on"],
  select: ["value"],
  check: [],
  uncheck: [],
  hover: [],
  drag: ["to"],
  wait: ["state"],
  expect: ["text", "count", "hidden", "attr", "value", "disabled"],
  read: [],
  snapshot: ["of"],
  screenshot: ["fullPage"],
  events: [],
  cli: ["actor"],
} as const satisfies Record<string, readonly string[]>;
type Op = keyof typeof OPS;
type Step = Record<string, unknown>;

// ロケータ。role（と name）を第一に使う。within で親のロケータの中に絞る
interface Spec {
  role?: string;
  name?: string;
  exact?: boolean;
  level?: number;
  label?: string;
  placeholder?: string;
  text?: string;
  testId?: string;
  hasText?: string;
  nth?: number;
  within?: Spec;
}
const SPEC_KEYS = ["role", "name", "exact", "level", "label", "placeholder", "text", "testId", "hasText", "nth", "within"];
const LOCATOR_OPS: Op[] = ["click", "fill", "select", "check", "uncheck", "hover", "drag", "wait", "expect", "read"];

function checkSpec(spec: unknown, where: string): Spec {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) throw new Fail(`${where}: ロケータはオブジェクトで書いてください`);
  const s = spec as Record<string, unknown>;
  const unknownKeys = Object.keys(s).filter((k) => !SPEC_KEYS.includes(k));
  if (unknownKeys.length > 0) throw new Fail(`${where}: ロケータに使えないキー ${unknownKeys.join(", ")}（使えるのは ${SPEC_KEYS.join(", ")}）`);
  if (!s.role && !s.label && !s.placeholder && !s.text && !s.testId) throw new Fail(`${where}: role・label・placeholder・text・testId のどれかを書いてください`);
  if (s.within !== undefined) checkSpec(s.within, `${where}.within`);
  return s as Spec;
}

function opOf(step: unknown, i: number): Op {
  if (typeof step !== "object" || step === null || Array.isArray(step)) throw new Fail(`手順 ${i}: オブジェクトで書いてください`);
  const ops = Object.keys(step).filter((k): k is Op => k in OPS);
  if (ops.length !== 1) throw new Fail(`手順 ${i}: 操作のキーを1つだけ書いてください（${Object.keys(OPS).join(", ")}）: ${JSON.stringify(step)}`);
  return ops[0] as Op;
}

// 実行の前に手順の形をすべて確かめる（途中まで操作してから書き間違いで止まらないように）
function checkSteps(raw: string): Step[] {
  let steps: unknown;
  try {
    steps = JSON.parse(raw);
  } catch (e) {
    throw new Fail(`手順が JSON として読めません: ${e}`);
  }
  if (!Array.isArray(steps) || steps.length === 0) throw new Fail("手順は1つ以上の要素を持つ JSON の配列で書いてください");
  steps.forEach((step: unknown, i) => {
    const op = opOf(step, i);
    const s = step as Step;
    const allowed: string[] = [op, "note", ...OPS[op]];
    const extra = Object.keys(s).filter((k) => !allowed.includes(k));
    if (extra.length > 0) throw new Fail(`手順 ${i}（${op}）: 使えないキー ${extra.join(", ")}（使えるのは ${allowed.join(", ")}）`);
    const v = s[op];
    if (LOCATOR_OPS.includes(op)) checkSpec(v, `手順 ${i}（${op}）`);
    if ((op === "goto" || op === "url") && (typeof v !== "string" || !v.startsWith("/"))) throw new Fail(`手順 ${i}（${op}）: "/" で始まるパスを書いてください（run の URL からの相対。別の origin は開かない）`);
    if ((op === "snapshot" || op === "screenshot") && (typeof v !== "string" || !NAME_RE.test(v))) throw new Fail(`手順 ${i}（${op}）: 名前は英小文字・数字・ハイフンで書いてください`);
    if (op === "press" && typeof v !== "string") throw new Fail(`手順 ${i}（press）: キーの名前を書いてください（例 "Enter"）`);
    if ((op === "fill" || op === "select") && typeof s.value !== "string") throw new Fail(`手順 ${i}（${op}）: value を文字列で書いてください`);
    if (op === "drag") checkSpec(s.to, `手順 ${i}（drag）.to`);
    if (op === "press" && s.on !== undefined) checkSpec(s.on, `手順 ${i}（press）.on`);
    if (op === "snapshot" && s.of !== undefined) checkSpec(s.of, `手順 ${i}（snapshot）.of`);
    if (op === "events" && v !== "ready" && v !== "connecting") throw new Fail(`手順 ${i}（events）: "ready" か "connecting" を書いてください`);
    if (op === "cli" && (!Array.isArray(v) || v.length === 0 || !v.every((a) => typeof a === "string"))) throw new Fail(`手順 ${i}（cli）: nod の引数を文字列の配列で書いてください（例 ["--json", "issue", "create", "タイトル"]）`);
    if (op === "cli" && s.actor !== undefined && (typeof s.actor !== "string" || s.actor === "")) throw new Fail(`手順 ${i}（cli）: actor は空でない文字列で書いてください`);
  });
  return steps as Step[];
}

type Playwright = typeof PlaywrightModule;

// Playwright はリポジトリの packages/web の devDependency にあり、ルートの node_modules には無い。
// この場所から静的に import できないので、packages/web から解決して browser のときだけ読み込む
async function loadPlaywright(): Promise<Playwright> {
  return (await import(Bun.resolveSync("@playwright/test", WEB_PKG))) as Playwright;
}

function locate(scope: Page | Locator, spec: Spec): Locator {
  const base = spec.within ? locate(scope, spec.within) : scope;
  let loc: Locator;
  if (spec.role) loc = base.getByRole(spec.role as Parameters<Page["getByRole"]>[0], { name: spec.name, exact: spec.exact, level: spec.level });
  else if (spec.label) loc = base.getByLabel(spec.label, { exact: spec.exact });
  else if (spec.placeholder) loc = base.getByPlaceholder(spec.placeholder, { exact: spec.exact });
  else if (spec.text) loc = base.getByText(spec.text, { exact: spec.exact });
  else loc = base.getByTestId(spec.testId as string);
  if (spec.hasText !== undefined) loc = loc.filter({ hasText: spec.hasText });
  if (spec.nth !== undefined) loc = loc.nth(spec.nth);
  return loc;
}

// スクリーンショットの上に run・URL・時刻の帯を付ける。帯は別のコンテキスト（外への要求をすべて止める）で描き、操作中のページは変えない
async function captioned(browser: Browser, png: Buffer, caption: string[]): Promise<Buffer> {
  const ctx = await browser.newContext({ viewport: { width: VIEWPORT.width, height: 100 }, javaScriptEnabled: false, serviceWorkers: "block" });
  try {
    await ctx.route(() => true, (route) => route.abort("blockedbyclient"));
    const page = await ctx.newPage();
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff">`
      + `<div style="padding:8px 12px;background:#1f2328;color:#fff;font:13px/1.5 Menlo,monospace;white-space:pre-wrap">${caption.join("\n").replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"))}</div>`
      + `<img style="display:block" src="data:image/png;base64,${png.toString("base64")}"></body>`,
    );
    return await page.screenshot({ fullPage: true });
  } finally {
    await ctx.close();
  }
}

interface StepResult {
  index: number;
  step: Step;
  ok: boolean;
  ms: number;
  url: string;
  status?: number | null;
  read?: string[];
  artifact?: string;
  cli?: { file: string; exitCode: number; actor: string };
  loads?: number;
  error?: string;
}

async function browser(args: string[]): Promise<number> {
  const feature = takeOption(args, "--feature");
  const stepsPath = takeOption(args, "--steps");
  const timeoutArg = takeOption(args, "--timeout");
  const timeout = timeoutArg === undefined ? BROWSER_TIMEOUT_MS : Number(timeoutArg);
  if (!Number.isInteger(timeout) || timeout <= 0) throw new Fail(`--timeout の値が正しくありません: ${timeoutArg}`);
  if (args.length !== 1) throw new Fail(`browser の引数が正しくありません: ${args.join(" ")}`);
  const p = resolveRun(args[0]);
  if (!feature || !FEATURE_RE.test(feature)) throw new Fail(`--feature <機能の ID> を指定してください（英小文字・数字・ハイフン。例 issue-create）`);
  const steps = checkSteps(stepsPath === undefined || stepsPath === "-" ? await Bun.stdin.text() : readFileSync(stepsPath, "utf8"));

  // 操作の前に、その run の doctor を通す。通らなければブラウザを起動しない
  const { checks } = await doctorChecks(p);
  if (checks.length === 0 || !checks.every((c) => c.ok)) {
    for (const c of checks.filter((c) => !c.ok)) process.stderr.write(`NG ${c.name}: ${c.detail}\n`);
    throw new Fail("doctor が通らないので、ブラウザで操作しません");
  }
  const state = readState(p) as State;
  const origin = `http://127.0.0.1:${state.port}`;
  const { dir, seq } = featureEvidence(p, feature);
  const logPath = join(dir, `${seq}-browser.json`);
  const record = {
    kind: "browser",
    feature,
    runId: state.runId,
    runDir: p.runDir,
    origin,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    ok: false,
    doctor: checks.map(({ name, ok }) => ({ name, ok })),
    steps: [] as StepResult[],
    artifacts: [] as string[],
    blocked: [] as string[],
    blockCheck: null as { url: string; blocked: boolean } | null,
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
    error: null as string | null,
  };

  const pw = await loadPlaywright();
  // Playwright が作る一時的なプロファイル（--user-data-dir）を run の tmp/ に置く。cleanup はこれを目印に残ったブラウザを止める
  process.env.TMPDIR = p.tmp;
  let instance: Browser | null = null;
  let page: Page | null = null;

  const save = async (index: number, kind: "snapshot" | "screenshot", name: string, opts: { of?: Spec; fullPage?: boolean } = {}): Promise<string> => {
    if (!page || !instance) throw new Fail("ページがありません");
    const base = join(dir, `${seq}-${String(index).padStart(2, "0")}-${name}`);
    const at = new Date().toISOString();
    if (kind === "snapshot") {
      const target = opts.of ? locate(page, opts.of) : page.locator("body");
      const yaml = await target.ariaSnapshot({ timeout });
      const file = `${base}.aria.yml`;
      writeFileSync(file, `# verify-nod run: ${state.runId}\n# url: ${page.url()}\n# at: ${at}\n# feature: ${feature} / step ${index}: ${name}\n${yaml}\n`);
      record.artifacts.push(file);
      return file;
    }
    const png = await page.screenshot({ fullPage: opts.fullPage ?? true, timeout });
    const file = `${base}.png`;
    writeFileSync(file, await captioned(instance, png, [`verify-nod run ${state.runId}  (${p.runDir})`, `URL: ${page.url()}`, `${at}  feature: ${feature}  step ${index}: ${name}`]));
    record.artifacts.push(file);
    return file;
  };

  const run = async (pg: Page, op: Op, step: Step, rec: StepResult): Promise<void> => {
    const v = step[op];
    const loc = () => locate(pg, v as Spec);
    const { expect } = pw;
    switch (op) {
      case "goto": {
        const res = await pg.goto(`${origin}${v as string}`);
        rec.status = res?.status() ?? null;
        return;
      }
      case "reload": {
        const res = await pg.reload();
        rec.status = res?.status() ?? null;
        return;
      }
      case "url": {
        const want = new URL(v as string, origin);
        await pg.waitForURL((u) => u.origin === origin && u.pathname === want.pathname && (want.search === "" || u.search === want.search));
        return;
      }
      case "click":
        return loc().click();
      case "fill":
        return loc().fill(step.value as string);
      case "press":
        return step.on ? locate(pg, step.on as Spec).press(v as string) : pg.keyboard.press(v as string);
      case "select":
        await loc().selectOption(step.value as string);
        return;
      case "check":
        return loc().check();
      case "uncheck":
        return loc().uncheck();
      case "hover":
        return loc().hover();
      case "drag":
        return loc().dragTo(locate(pg, step.to as Spec));
      case "wait":
        return loc().waitFor({ state: (step.state as "attached" | "detached" | "visible" | "hidden" | undefined) ?? "visible" });
      case "expect": {
        const l = loc();
        const o = { timeout };
        if (step.count !== undefined) await expect(l).toHaveCount(step.count as number, o);
        else if (step.hidden === true) await expect(l).toBeHidden(o);
        else await expect(l).toBeVisible(o);
        if (step.text !== undefined) await expect(l).toContainText(step.text as string | string[], o);
        if (step.value !== undefined) await expect(l).toHaveValue(step.value as string, o);
        for (const [k, want] of Object.entries((step.attr ?? {}) as Record<string, string>)) await expect(l).toHaveAttribute(k, want, o);
        if (step.disabled === true) await expect(l).toBeDisabled(o);
        if (step.disabled === false) await expect(l).toBeEnabled(o);
        return;
      }
      case "read":
        await loc().first().waitFor();
        rec.read = await loc().allInnerTexts();
        return;
      case "snapshot":
        rec.artifact = await save(rec.index, "snapshot", v as string, { of: step.of as Spec | undefined });
        return;
      case "screenshot":
        rec.artifact = await save(rec.index, "screenshot", v as string, { fullPage: step.fullPage as boolean | undefined });
        return;
      case "events":
        // Web が出す変更通知（SSE）の接続の状態。<html data-server-events> を待つ
        await expect(pg.locator("html")).toHaveAttribute("data-server-events", v as string, { timeout });
        return;
      case "cli": {
        // ページを開いたまま、同じ run の CLI で書く。記録は <番号>-<手順>-cli.json
        const actor = (step.actor as string | undefined) ?? DEFAULT_ACTOR;
        const nodArgs = v as string[];
        const file = join(dir, `${seq}-${String(rec.index).padStart(2, "0")}-cli.json`);
        const startedAt = new Date().toISOString();
        const r = await runCli(p, actor, nodArgs, "ignore");
        writeCliEvidence(p, file, feature, actor, nodArgs, r, startedAt);
        record.artifacts.push(file);
        rec.cli = { file, exitCode: r.exitCode, actor };
        if (r.exitCode !== 0) throw new Fail(`CLI が終了コード ${r.exitCode} で終わりました: ${r.stderr.trim() || r.stdout.trim()}`);
        return;
      }
    }
  };

  try {
    instance = await pw.chromium.launch({ headless: true, env: { PATH: SAFE_PATH, HOME: p.home, TMPDIR: p.tmp } });
    // 毎回新しいコンテキスト（利用者のプロファイル・cookie を使わない）
    const context = await instance.newContext({ viewport: VIEWPORT, locale: "ja-JP", serviceWorkers: "block" });
    context.setDefaultTimeout(timeout);
    context.setDefaultNavigationTimeout(timeout);
    // その run の origin 以外（127.0.0.1:4700・localhost:4700 や外部）への要求はブラウザ側で止める
    await context.route(() => true, (route) => {
      const url = route.request().url();
      if (new URL(url).origin === origin) return route.continue();
      record.blocked.push(url);
      return route.abort("blockedbyclient");
    });
    await context.routeWebSocket(() => true, (ws) => {
      if (new URL(ws.url()).host === new URL(origin).host) return ws.connectToServer();
      record.blocked.push(ws.url());
      return ws.close();
    });
    page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") record.consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => record.pageErrors.push(String(e)));
    // 文書の読み込み（goto・reload）の回数。手順ごとに記録し、再読み込みなしで変わったことを示す
    let loads = 0;
    page.on("load", () => {
      loads += 1;
    });
    // 止める仕組みが効いていることを、操作の前に自分の nod への別の origin（localhost:<ポート>）で確かめる。
    // 止まらなければ自分の nod に届くだけで、利用者の nod には触れない
    const probe = `http://localhost:${state.port}/api/workspaces`;
    await page.evaluate((url) => fetch(url).then(() => "fetched", (e: unknown) => String(e)), probe);
    record.blockCheck = { url: probe, blocked: record.blocked.includes(probe) };
    if (!record.blockCheck.blocked) throw new Fail(`別の origin への要求が止まりませんでした（${probe}）。操作をやめます`);

    for (const [index, step] of steps.entries()) {
      const op = opOf(step, index);
      const rec: StepResult = { index, step, ok: false, ms: 0, url: "" };
      record.steps.push(rec);
      const t0 = Date.now();
      try {
        await run(page, op, step, rec);
        rec.ok = true;
      } catch (e) {
        rec.error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        rec.ms = Date.now() - t0;
        rec.url = page.url();
        rec.loads = loads;
      }
    }
    record.ok = true;
  } catch (e) {
    record.error = e instanceof Error ? e.message : String(e);
    // 失敗したときの画面も残す
    if (page && instance) {
      for (const kind of ["snapshot", "screenshot"] as const) {
        try {
          await save(Math.max(0, record.steps.length - 1), kind, "failure");
        } catch {
          // 画面が無いときは記録しない
        }
      }
    }
  } finally {
    record.finishedAt = new Date().toISOString();
    writeJson(logPath, record);
    await instance?.close();
  }
  console.log(JSON.stringify({ ok: record.ok, runId: state.runId, feature, origin, log: logPath, artifacts: record.artifacts, blockCheck: record.blockCheck, blocked: record.blocked, error: record.error }, null, 2));
  if (!record.ok) process.stderr.write(`verify-nod: ${record.steps.length === 0 ? "操作の前" : `手順 ${record.steps.length - 1}`}で失敗しました: ${record.error}\n`);
  return record.ok ? 0 : 1;
}

const HELP = `verify-nod.ts <サブコマンド>
  launch                         空の置き場に run を作り、web をビルドし、Workspace を登録して nod ui を起動する
  doctor <run> [--port <番号>]   読み取りだけの状態確認（--port で照合先のポートを変える。4700 は拒む）
  cli <run> [--actor <名前>] [--evidence <機能の ID>] -- <nod の引数...>
                                 検証の nod と同じデータでソースの CLI を実行する（--evidence で evidence/<機能の ID>/ に記録）
  browser <run> --feature <機能の ID> [--steps <JSON のファイル>|-] [--timeout <ミリ秒>]
                                 doctor を通してから、手順（JSON の配列。既定は標準入力）を新しいブラウザのコンテキストで実行し、
                                 evidence/<機能の ID>/ に記録・ARIA スナップショット・スクリーンショットを残す
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
    case "browser":
      return browser(rest);
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
