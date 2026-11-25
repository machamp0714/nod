#!/usr/bin/env -S bun --no-env-file
// verify-nod の補助スクリプト。作業ツリーのソースの nod を、実行ごとの置き場と空いているポートで隔離して起動し、
// 状態確認（doctor）、CLI・Web の操作と証拠の保存（cli・browser）、後始末（cleanup）を行う。使い方は SKILL.md と `verify-nod.ts help` を見る。
//
// 守ること:
// - 利用者の nod（ポート 4700、~/.local/share/nod、~/.config/nod、~/Applications/nod.app）に触れない。4700 には接続しない。
//   nod ui は cli から実行させない（ポートを省くと 4700 に接続・待ち受けし、ブラウザを開くため。検証の nod ui は launch が起動する）
// - 検証の nod に渡す環境変数は nodEnv() の許可リストだけ。親の process.env を混ぜない。PATH は run の bin/（git だけ）で、open・gh などは見つからない
// - ブラウザは新しいコンテキストで開き、その run の origin 以外への要求をブラウザ側で止める
// - プロセスは名前で止めない。止める・調べるプロセスは ownership() で持ち主を判定し、stopProcesses() だけで止める。
//   自分のもの（記録した起動の argv と一致する server、この run の tmp/ をプロファイルに持つブラウザ、launch が持つ子）にだけシグナルを送り、
//   環境変数もそのときだけ読む。別のプロセス（PID の再利用など）には触れない
// - 後始末は作業用のデータとプロセスだけを消し、evidence/ を残す
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
// 型だけ。実行時は packages/web から解決して読み込む（loadPlaywright）
import type { Browser, Locator, Page } from "../../../../packages/web/node_modules/@playwright/test";
import type * as PlaywrightModule from "../../../../packages/web/node_modules/@playwright/test";

const USER_PORT = 4700;
const WORKTREE = resolve(import.meta.dir, "../../../..");
const CLI_MAIN = join(WORKTREE, "packages/cli/src/main.ts");
const WEB_PKG = join(WORKTREE, "packages/web");
const VITE_BIN = join(WEB_PKG, "node_modules/vite/bin/vite.js");
const BUN = process.execPath;
// web のビルド・git init・ps / lsof・ブラウザに渡す最小の PATH。検証の nod には渡さない（nodEnv の PATH は run の bin/）
const SAFE_PATH = "/usr/bin:/bin";
const GIT = "/usr/bin/git";
const PS = "/bin/ps";
const LSOF = "/usr/sbin/lsof";
const DEFAULT_ACTOR = "verify-nod";
const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{5}$/;
const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const KILL_WAIT_MS = 2_000;

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
  bin: string;
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
    bin: join(runDir, "bin"), // 検証の nod の PATH。git（/usr/bin/git へのシンボリックリンク）だけを置く
    web: join(runDir, "web"),
    logs,
    uiStdout: join(logs, "ui.stdout.log"),
    uiStderr: join(logs, "ui.stderr.log"),
    evidence: join(runDir, "evidence"),
  };
}

// 検証の nod（server と CLI）に渡す環境変数の許可リスト。これ以外は渡さない。
// PATH は run の bin/ だけ。nod が名前で実行する git は見つかり、gh（PR の状態）と open（nod ui のブラウザ）は見つからない
function nodEnv(p: Layout, actor = DEFAULT_ACTOR): Record<string, string> {
  return {
    PATH: p.bin,
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

// child が parent の中（parent 自身を含む）か。どちらも realish で実パスにしてから、パスの要素で判定する
// （外は、相対パスが ".." そのものか ".." に区切りが続くとき、または絶対パスになるときだけ。"..x" のような名前は中）。
// macOS の既定のファイルシステムは大文字小文字を区別しないので、まだ無い名前も含めて大文字小文字をそろえて比べる
function isInside(child: string, parent: string): boolean {
  const norm = (path: string) => (process.platform === "darwin" ? realish(path).toLowerCase() : realish(path));
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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
    if (isInside(root, dir)) throw new Fail(`置き場の根 ${root} は ${dir} の中にあります。作業ツリーと利用者の nod のデータの外を指定してください`);
  }
  return root;
}

// 引数は run の ID（根の下）か、run のディレクトリの絶対パス。相対パス（"../x/<ID>" など）は run の ID とみなさない
function resolveRun(ref: string | undefined): Layout {
  if (!ref) throw new Fail("run の ID かディレクトリを指定してください（launch の出力の runId / runDir）");
  if (!isAbsolute(ref) && !RUN_ID_RE.test(ref)) throw new Fail(`${ref} は run の ID（YYYYMMDD-HHMMSS-<16進5桁>）でも、run のディレクトリの絶対パスでもありません`);
  const runDir = isAbsolute(ref) ? realish(ref) : join(rootDir(), ref);
  if (!RUN_ID_RE.test(basename(runDir))) throw new Fail(`${runDir} は verify-nod の run のディレクトリではありません（名前が run の ID の形でない）`);
  if (!existsSync(runDir)) {
    throw new Fail(`${runDir} がありません。runId で指定したときは VERIFY_NOD_ROOT が launch のときと同じか確かめるか、runDir の絶対パスを指定してください`);
  }
  if (!existsSync(join(runDir, "evidence"))) throw new Fail(`${runDir} は verify-nod の run のディレクトリではありません（evidence/ が無い）`);
  for (const dir of forbiddenDirs()) {
    if (isInside(runDir, dir)) throw new Fail(`${runDir} は ${dir} の中にあります`);
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

// ---- プロセスの持ち主の判定と止め方。server・ブラウザ・launch の子の PID は、すべてここを通す ----

// 誰のプロセスとして扱うか
type Owner =
  | { kind: "server"; state: State; p: Layout } // 状態ファイルに記録したこの run の server（記録した起動の argv で判定）
  | { kind: "browser"; p: Layout } // browser が起動したブラウザ（Playwright の headless shell で、--user-data-dir がこの run の tmp/ の下のプロファイル）
  | { kind: "child"; proc: Subprocess }; // launch がいま起動した子（ハンドルを持ち、まだ回収していない間は PID が再利用されない）

// mine: 自分のプロセス。other: 別のプロセス（PID の再利用など。シグナルを送らず、環境変数も読まない）。gone: もう無い
type Ownership = "mine" | "other" | "gone";

// browser が起動したブラウザか。実行ファイルが Playwright の headless shell（chrome-headless-shell）で、引数の1つが
// --user-data-dir=<この run の tmp/>/<Playwright のプロファイル> と完全に一致するときだけ。コマンドラインのどこかにその文字を含むだけのプロセス（シェル、grep など）は別のプロセス
function isRunBrowser(cmd: string, p: Layout): boolean {
  const exe = /^\S+/.exec(cmd)?.[0] ?? "";
  const tmp = p.tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return basename(exe) === "chrome-headless-shell" && new RegExp(`(?:^| )--user-data-dir=${tmp}/playwright_chromiumdev_profile-[A-Za-z0-9]+(?: |$)`).test(cmd);
}

// その PID が自分のものかの唯一の判定。server は、状態ファイルに記録した起動の argv（どの作業ツリーから launch したかを含む）が
// その run の web/ を指すソースの CLI の ui で、PID のコマンドラインがその argv と一致するときだけ mine
function ownership(pid: number, owner: Owner): Ownership {
  if (owner.kind === "child") return owner.proc.exitCode === null && owner.proc.signalCode === null ? "mine" : "gone";
  const cmd = commandLine(pid);
  if (cmd === null) return "gone";
  if (owner.kind === "browser") return isRunBrowser(cmd, owner.p) ? "mine" : "other";
  const { state, p } = owner;
  const argv = state.argv;
  if (!argv) return "other";
  const webDir = argv[argv.indexOf("--web-dir") + 1];
  const mine = argv.includes(join(state.worktree, "packages/cli/src/main.ts")) && argv.includes("ui") && webDir === p.web && cmd === argv.join(" ");
  return mine ? "mine" : "other";
}

// 送る直前に持ち主を確かめ、自分のものにだけシグナルを送る。送る前後に終わっていれば（ESRCH）gone、送れなければ（EPERM）other
function signal(pid: number, owner: Owner, sig: "SIGTERM" | "SIGKILL"): Ownership {
  const o = ownership(pid, owner);
  if (o !== "mine") return o;
  try {
    process.kill(pid, sig);
    return "mine";
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? e.code : null;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "other";
    throw e;
  }
}

interface Stopped {
  pid: number;
  result: string;
  running: boolean; // 自分のプロセスが SIGKILL の後も動いている
}

const NOT_RUNNING = "停止済み（シグナルを送る前に終わっていた）";
const NOT_OWNED = "触れない（この PID は別のプロセス。PID の再利用など。シグナルを送らず、コマンドラインと環境も記録しない）";

// 自分のプロセスだけを止める唯一の止め方。SIGTERM を送って最大10秒待ち、残れば SIGKILL を送って待つ。
// 送る直前と待つ間は ownership で確かめ、終わったか別のプロセスに替わったら止まったとみなす。ESRCH・EPERM で中断しない
async function stopProcesses(targets: { pid: number; owner: Owner }[]): Promise<Stopped[]> {
  const results: Stopped[] = [];
  let live = targets;
  let sent: "SIGTERM" | "SIGKILL" | null = null;
  for (const [sig, wait] of [["SIGTERM", STOP_TIMEOUT_MS], ["SIGKILL", KILL_WAIT_MS]] as const) {
    live = live.filter((t) => {
      const o = signal(t.pid, t.owner, sig);
      if (o === "mine") return true;
      results.push({ pid: t.pid, result: sent ? `${sent} で停止` : o === "gone" ? NOT_RUNNING : NOT_OWNED, running: false });
      return false;
    });
    sent = sig;
    const deadline = Date.now() + wait;
    while (live.some((t) => ownership(t.pid, t.owner) === "mine") && Date.now() < deadline) await Bun.sleep(100);
    live = live.filter((t) => {
      if (ownership(t.pid, t.owner) === "mine") return true;
      results.push({ pid: t.pid, result: `${sig} で停止`, running: false });
      return false;
    });
  }
  for (const t of live) results.push({ pid: t.pid, result: "止まらない（SIGKILL の後も動いている）", running: true });
  return results;
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

// browser が起動したブラウザのうち残っているものの候補（isRunBrowser）
// （止める直前に ownership で確かめ直すので、一覧の後に終わった・入れ替わったプロセスには触れない）
function browserProcesses(p: Layout): number[] {
  const r = exec([PS, "-ax", "-ww", "-o", "pid=,command="], { env: SYS_ENV });
  return r.stdout.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m?.[1] && m[2] !== undefined && isRunBrowser(m[2], p) ? [Number(m[1])] : [];
  });
}

// ps eww の出力（コマンドラインに続けて環境変数）と許可リストを比べ、違う変数の名前だけを返す（値は出さない）
function envMismatch(envLine: string, argv: string[], expected: Record<string, string>): string[] {
  const command = argv.join(" ");
  if (!envLine.startsWith(command)) return ["（コマンドラインが記録と違う）"];
  const actual = new Map<string, string>();
  let last: string | null = null;
  for (const token of envLine.slice(command.length).trim().split(" ").filter(Boolean)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
    if (m?.[1] !== undefined) {
      last = m[1];
      actual.set(last, m[2] ?? "");
    } else if (last !== null) {
      actual.set(last, `${actual.get(last)} ${token}`); // 値の中の空白
    }
  }
  const names = new Set([...Object.keys(expected), ...actual.keys()]);
  return [...names].filter((k) => expected[k] !== actual.get(k)).map((k) => (!(k in expected) ? `${k}（余分）` : !actual.has(k) ? `${k}（無い）` : `${k}（値が違う）`));
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

  const own = ownership(state.pid, { kind: "server", state, p });
  const owned = own === "mine";
  push("pid-alive", own !== "gone", own !== "gone" ? `PID ${state.pid} は動いている` : `PID ${state.pid} は動いていません`);
  // この run の server と確かめられないプロセスは、コマンドラインの中身も環境変数も出さない（別のプロセスの秘密を出力に載せない）
  push("pid-command", owned, owned ? `PID ${state.pid}: ${state.argv.join(" ")}`
    : own === "gone" ? "PID が動いていないので、コマンドラインはありません"
    : `PID ${state.pid} のコマンドラインが、状態ファイルに記録したこの run の起動の argv と一致しません（別のプロセス。中身は出しません）`);

  const expected = nodEnv(p);
  if (!owned) {
    push("pid-env", false, "PID がこの run の server と確かめられないので、環境変数を読みません");
  } else {
    const envLine = environmentLine(state.pid);
    const diff = envLine === null ? ["（読めない）"] : envMismatch(envLine, state.argv, expected);
    push("pid-env", diff.length === 0, diff.length === 0
      ? `環境変数は許可リストの ${Object.keys(expected).length} 項目だけ`
      : `環境変数が許可リストと一致しません: ${diff.join(", ")}`);
  }

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
  for (const dir of [p.data, p.docs, p.attachments, p.home, p.tmp, p.config, p.viteEnv, p.repo, p.bin, p.web, p.logs, p.evidence]) mkdirSync(dir, { recursive: true });
  symlinkSync(GIT, join(p.bin, "git"));
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
    const [stopped] = proc ? await stopProcesses([{ pid: proc.pid, owner: { kind: "child", proc } }]) : [];
    log(`起動に失敗しました。起動した nod ui: ${stopped ? `PID ${stopped.pid} ${stopped.result}` : "（起動前）"}。ログを読んだら cleanup ${p.runDir} で作業用のデータを消してください`);
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

async function stopBrowsers(p: Layout): Promise<Stopped[]> {
  const results: Stopped[] = [];
  // 1回目の後に現れたもの（止める間に起動したブラウザの子など）も、もう一度だけ探して止める
  for (let round = 0; round < 2; round++) {
    const seen = new Set(results.map((r) => r.pid));
    const pids = browserProcesses(p).filter((pid) => !seen.has(pid));
    if (pids.length === 0) break;
    results.push(...(await stopProcesses(pids.map((pid) => ({ pid, owner: { kind: "browser", p } as const })))));
  }
  return results;
}

// 自分のプロセス（残ったブラウザと、記録した PID が自分の server と判定できたもの）だけを止め、作業用のデータを消す。
// 記録した PID がもう無いか別のプロセスなら、触れずにデータを消す。自分のプロセスが SIGKILL の後も動いていれば、データを消さずに終了コード 1
async function cleanup(args: string[]): Promise<number> {
  const p = resolveRun(args[0]);
  const state = readState(p);
  const browsers = await stopBrowsers(p);
  const [server = null] = state?.pid ? await stopProcesses([{ pid: state.pid, owner: { kind: "server", state, p } }]) : [];
  const running = [...browsers, ...(server ? [server] : [])].filter((r) => r.running);
  // evidence/ は消さない
  const removed = running.length > 0 ? [] : [p.data, p.home, p.tmp, p.config, p.repo, p.bin, p.web, p.logs, p.state].filter((path) => existsSync(path));
  for (const path of removed) rmSync(path, { recursive: true, force: true });
  const ok = running.length === 0;
  const recordPath = join(p.evidence, "cleanup.json");
  const record = existsSync(recordPath) ? (JSON.parse(readFileSync(recordPath, "utf8")) as unknown[]) : [];
  record.push({ at: new Date().toISOString(), ok, server: server ?? "起動したプロセスの記録なし", browsers, removed });
  writeJson(recordPath, record);
  if (!ok) throw new Fail(`自分が起動したプロセス（PID ${running.map((r) => r.pid).join(", ")}）が SIGKILL の後も動いています。動いている間は作業用のデータを消しません（${recordPath} に記録した）`);
  const left = readdirSync(p.runDir);
  console.log(JSON.stringify({ ok, runDir: p.runDir, server: server ?? "起動したプロセスの記録なし", browsers, removed, left, evidence: p.evidence }, null, 2));
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
        // 判定は状態ファイルに記録した起動の argv で行う（list を実行した作業ツリーによらない）
        alive: state?.pid ? ownership(state.pid, { kind: "server", state, p }) === "mine" : false,
        url: state?.url ?? null,
      };
    })
    : [];
  console.log(JSON.stringify({ root, runs }, null, 2));
  return 0;
}

// 証拠の置き場は <run>/evidence/<機能の ID>/。ファイル名の先頭の数字（3桁以上）は、その置き場での呼び出しごとの通し番号
const FEATURE_RE = /^[a-z0-9][a-z0-9-]*$/;
const SEQ_RE = /^\.?(\d{3,})-/;

interface EvidenceSlot {
  dir: string;
  seq: string;
  release(): void;
}

// 番号を確保する。.<番号>-claim を排他で作り、ほかにその番号のファイルが無いことを確かめてから使う
// （同じ機能の cli・browser を並行に呼んでも、呼び出しごとに別の番号になる）。証拠を書いたら release() で .<番号>-claim を消す
function featureEvidence(p: Layout, feature: string | undefined): EvidenceSlot {
  if (!feature || !FEATURE_RE.test(feature)) throw new Fail(`機能の ID が正しくありません: ${feature ?? "（なし）"}（英小文字・数字・ハイフン。例 issue-create）`);
  const dir = join(p.evidence, feature);
  mkdirSync(dir, { recursive: true });
  const used = () => readdirSync(dir).flatMap((n) => {
    const m = SEQ_RE.exec(n);
    return m?.[1] ? [{ name: n, seq: Number(m[1]) }] : [];
  });
  for (;;) {
    const n = Math.max(0, ...used().map((u) => u.seq)) + 1;
    const seq = String(n).padStart(3, "0");
    const claim = join(dir, `.${seq}-claim`);
    try {
      closeSync(openSync(claim, "wx"));
    } catch (e) {
      if (typeof e === "object" && e !== null && "code" in e && e.code === "EEXIST") continue;
      throw e;
    }
    // 確保する前に、別の呼び出しがこの番号の証拠を書き終えて claim を消していたら、次の番号にする
    if (used().some((u) => u.seq === n && u.name !== `.${seq}-claim`)) {
      rmSync(claim, { force: true });
      continue;
    }
    return { dir, seq, release: () => rmSync(claim, { force: true }) };
  }
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

// nod ui は検証の入口（cli・browser の cli の手順）から実行しない。ポートを省くと既定の 4700 で待ち受けようとし、
// 使用中なら 4700 に GET して既存の nod と判定し、その URL をブラウザで開く。commander は「ui」をどの位置（--json・-w <値>・-- の後ろ）でも
// サブコマンドとして解釈しうるので、引数のどこかに「ui」がそのままあれば CLI を起動せずに拒む（Issue のタイトルなどが「ui」のときも拒む）。
// ブラウザを開く open は、検証の nod の PATH（run の bin/）に無いので見つからない
function refuseUi(nodArgs: string[], where: string): void {
  if (nodArgs.includes("ui")) {
    throw new Fail(`${where}: nod の引数に ui があるので実行しません（nod ui は既定のポート ${USER_PORT} の利用者の nod に接続・待ち受けし、ブラウザを開く。検証の nod ui は launch が起動したものを使う）`);
  }
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
  refuseUi(nodArgs, "cli");
  const actor = takeOption(own, "--actor") ?? DEFAULT_ACTOR;
  const feature = takeOption(own, "--evidence");
  if (own.length !== 1) throw new Fail(`cli の引数が正しくありません: ${own.join(" ")}`);
  const p = resolveRun(own[0]);
  if (!existsSync(p.db)) throw new Fail(`${p.db} がありません（後始末済み）`);
  if (feature === undefined) {
    const r = Bun.spawnSync([BUN, "--no-env-file", CLI_MAIN, ...nodArgs], { cwd: p.repo, env: nodEnv(p, actor), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return r.exitCode ?? 1;
  }
  const slot = featureEvidence(p, feature);
  try {
    const startedAt = new Date().toISOString();
    const r = await runCli(p, actor, nodArgs, "inherit");
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    const file = join(slot.dir, `${slot.seq}-cli.json`);
    writeCliEvidence(p, file, feature, actor, nodArgs, r, startedAt);
    process.stderr.write(`verify-nod: 証拠 ${file}\n`);
    return r.exitCode;
  } finally {
    slot.release();
  }
}

// ---- browser: Playwright で Web を操作し、ARIA スナップショットとスクリーンショットを残す ----

const BROWSER_TIMEOUT_MS = 10_000;
const VIEWPORT = { width: 1440, height: 960 };
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
// 手順の goto・url の行き先の判定に check-steps が使う仮の origin（run を持たないので。実行のときは run の origin でもう一度判定する）
const CHECK_ORIGIN = "http://127.0.0.1:1";

// 手順の goto・url の行き先を、origin を基点に URL として解き、origin が同じときだけ返す。
// "//host"・"/\host"・"/<タブ>/host" のように "/" で始まっても別の origin に解けるものは null
function sameOriginUrl(path: string, origin: string): URL | null {
  if (!path.startsWith("/")) return null;
  try {
    const url = new URL(path, origin);
    return url.origin === origin ? url : null;
  } catch {
    return null;
  }
}

// ---- 手順の定義。検査（checkSteps）と実行（browser の run・locate）は、この定義の項目だけを扱う ----

// 項目の型。真偽値は真偽値だけ、整数は整数だけ、文字列は文字列だけを受け付ける
type FieldType = "path" | "true" | "locator" | "key" | "name" | "boolean" | "count" | "text" | "string" | "attr" | "waitState" | "events" | "args" | "actor" | "note";

// 1つの手順に種類のキーを1つだけ書く。main はその値の型、fields は添えてよい項目と型、required は必ず書く項目。どの手順にも説明の note を書ける
interface StepSchema {
  readonly main: FieldType;
  readonly fields: Readonly<Record<string, FieldType>>;
  readonly required?: readonly string[];
}
const STEPS = {
  goto: { main: "path", fields: {} },
  reload: { main: "true", fields: {} },
  url: { main: "path", fields: {} },
  click: { main: "locator", fields: {} },
  fill: { main: "locator", fields: { value: "string" }, required: ["value"] },
  press: { main: "key", fields: { on: "locator" } },
  select: { main: "locator", fields: { value: "string" }, required: ["value"] },
  check: { main: "locator", fields: {} },
  uncheck: { main: "locator", fields: {} },
  hover: { main: "locator", fields: {} },
  drag: { main: "locator", fields: { to: "locator" }, required: ["to"] },
  wait: { main: "locator", fields: { state: "waitState" } },
  expect: { main: "locator", fields: { count: "count", hidden: "true", text: "text", value: "string", attr: "attr", disabled: "boolean" } },
  read: { main: "locator", fields: {} },
  snapshot: { main: "name", fields: { of: "locator" } },
  screenshot: { main: "name", fields: { fullPage: "boolean" } },
  events: { main: "events", fields: {} },
  cli: { main: "args", fields: { actor: "actor" } },
} as const satisfies Record<string, StepSchema>;
type Op = keyof typeof STEPS;
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
// ロケータの基点（1つだけ書く）と、それぞれに添えてよい項目。hasText・nth・within はどれにも添えられる
const SPEC_BASES = { role: ["name", "exact", "level"], label: ["exact"], placeholder: ["exact"], text: ["exact"], testId: [] } as const satisfies Record<string, readonly (keyof Spec)[]>;
const SPEC_COMMON = ["hasText", "nth", "within"] as const satisfies readonly (keyof Spec)[];
const WAIT_STATES = ["visible", "hidden", "attached", "detached"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v !== "";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function need(ok: boolean, where: string, what: string): void {
  if (!ok) throw new Fail(`${where}: ${what}`);
}

function checkSpec(spec: unknown, where: string): void {
  need(isObject(spec), where, "ロケータはオブジェクトで書いてください");
  const s = spec as Record<string, unknown>;
  const bases = Object.keys(s).filter((k): k is keyof typeof SPEC_BASES => Object.hasOwn(SPEC_BASES, k));
  need(bases.length === 1, where, `ロケータの基点 ${Object.keys(SPEC_BASES).join("・")} のどれか1つだけを書いてください（書いたもの: ${bases.join(", ") || "なし"}）`);
  const base = bases[0] as keyof typeof SPEC_BASES;
  const allowed: string[] = [base, ...SPEC_BASES[base], ...SPEC_COMMON];
  const extra = Object.keys(s).filter((k) => !allowed.includes(k));
  need(extra.length === 0, where, `ロケータに ${base} と組み合わせられない項目 ${extra.join(", ")}（${base} に使えるのは ${allowed.join(", ")}）`);
  for (const k of [base, "name", "hasText"]) if (Object.hasOwn(s, k)) need(isText(s[k]), `${where}.${k}`, "空でない文字列で書いてください");
  if (Object.hasOwn(s, "exact")) {
    need(typeof s.exact === "boolean", `${where}.exact`, "true か false で書いてください（文字列・数値は書けない）");
    need(base !== "role" || Object.hasOwn(s, "name"), `${where}.exact`, "role の exact は name の一致のしかたなので、name と一緒に書いてください");
  }
  if (Object.hasOwn(s, "level")) need(isInt(s.level) && s.level >= 1 && s.level <= 6, `${where}.level`, "1〜6 の整数で書いてください");
  if (Object.hasOwn(s, "nth")) need(isInt(s.nth) && s.nth >= 0, `${where}.nth`, "0 以上の整数で書いてください");
  if (Object.hasOwn(s, "within")) checkSpec(s.within, `${where}.within`);
}

// 項目の型ごとの検査。where は「手順 <番号>（<種類>）.<項目>」
const CHECK: Record<FieldType, (v: unknown, where: string) => void> = {
  path: (v, w) => need(isText(v) && sameOriginUrl(v, CHECK_ORIGIN) !== null, w, `"/" で始まるパスの文字列で書いてください（run の URL を基点に解いて同じ origin になるもの。"//"・"/\\" で始まるなど別の origin に解けるものは書けない）`),
  true: (v, w) => need(v === true, w, "true だけを書けます"),
  locator: checkSpec,
  key: (v, w) => need(isText(v), w, `キーの名前を空でない文字列で書いてください（例 "Enter"）`),
  name: (v, w) => need(typeof v === "string" && NAME_RE.test(v), w, "名前は英小文字・数字・ハイフンの文字列で書いてください"),
  boolean: (v, w) => need(typeof v === "boolean", w, "true か false で書いてください（文字列・数値・null は書けない）"),
  count: (v, w) => need(isInt(v) && v >= 0, w, "0 以上の整数で書いてください"),
  text: (v, w) => need(isText(v) || (Array.isArray(v) && v.length > 0 && v.every(isText)), w, "空でない文字列か、空でない文字列の配列（1つ以上）で書いてください"),
  string: (v, w) => need(typeof v === "string", w, "文字列で書いてください"),
  attr: (v, w) => need(isObject(v) && Object.keys(v).length > 0 && Object.entries(v).every(([k, x]) => k !== "" && typeof x === "string"), w, `属性の名前と値（文字列）のオブジェクトで、1つ以上書いてください（例 {"data-value": "todo"}）`),
  waitState: (v, w) => need(typeof v === "string" && WAIT_STATES.includes(v), w, `${WAIT_STATES.join("・")} のどれかを書いてください`),
  events: (v, w) => need(v === "ready" || v === "connecting", w, `"ready" か "connecting" を書いてください`),
  args: (v, w) => {
    need(Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === "string"), w, `nod の引数を文字列の配列（1つ以上）で書いてください（例 ["--json", "issue", "create", "タイトル"]）`);
    refuseUi(v as string[], w);
  },
  actor: (v, w) => need(isText(v), w, "空でない文字列で書いてください"),
  note: (v, w) => need(typeof v === "string", w, "文字列で書いてください"),
};

function opOf(step: unknown, i: number): Op {
  need(isObject(step), `手順 ${i}`, "オブジェクトで書いてください");
  const ops = Object.keys(step as Step).filter((k): k is Op => Object.hasOwn(STEPS, k));
  need(ops.length === 1, `手順 ${i}`, `種類のキー（${Object.keys(STEPS).join(", ")}）を1つだけ書いてください（書いたもの: ${ops.join(", ") || "なし"}）`);
  return ops[0] as Op;
}

// expect の検査項目の組み合わせ。count・hidden・text・value・attr・disabled は書いたものをすべて検査する。
// 必ず失敗する組み合わせ（0 件の中身、複数に当たる1要素の検査、当たる要素の数より長い text の配列）は、ブラウザを起動する前に拒む
function checkExpect(s: Step, where: string): void {
  const count = s.count as number | undefined;
  const texts = Array.isArray(s.text) ? s.text.length : 1;
  if (texts > 1) {
    need(count !== undefined && count >= texts, where, `text の配列（${texts} 個）は要素ごとに当てるので、count に ${texts} 以上を書いてください（count を省くと「1つだけ見えている」を確かめるので必ず失敗する）`);
  }
  if (count === undefined) return;
  const single = ["value", "attr", "disabled"].filter((k) => Object.hasOwn(s, k));
  if (count === 0) {
    const others = [...single, ...(Object.hasOwn(s, "text") ? ["text"] : [])];
    need(others.length === 0, where, `count: 0 と ${others.join(", ")} は組み合わせられません（0 件の要素の中身は確かめられない）`);
  }
  if (count > 1) {
    const others = [...single, ...(Object.hasOwn(s, "hidden") ? ["hidden"] : []), ...(typeof s.text === "string" ? ["text（文字列）"] : [])];
    need(others.length === 0, where, `count が 2 以上のときは ${others.join(", ")} を組み合わせられません（1つの要素を確かめる検査なので、複数に当たると必ず失敗する）。文字は text に要素ごとの配列で書く`);
  }
}

// 実行の前に、手順の形をこの定義ですべて確かめる（ブラウザも doctor も起動しない。途中まで操作してから書き間違いで止まらないように）
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
    const schema: StepSchema = STEPS[op];
    const where = `手順 ${i}（${op}）`;
    const allowed = [op, "note", ...Object.keys(schema.fields)];
    const extra = Object.keys(s).filter((k) => !allowed.includes(k));
    need(extra.length === 0, where, `使えない項目 ${extra.join(", ")}（${op} に使えるのは ${allowed.join(", ")}）`);
    for (const k of schema.required ?? []) need(Object.hasOwn(s, k), where, `${k} を書いてください`);
    CHECK[schema.main](s[op], `${where}.${op}`);
    for (const [k, type] of Object.entries(schema.fields)) if (Object.hasOwn(s, k)) CHECK[type](s[k], `${where}.${k}`);
    if (Object.hasOwn(s, "note")) CHECK.note(s.note, `${where}.note`);
    if (op === "expect") checkExpect(s, where);
  });
  return steps as Step[];
}

// 手順の形だけを確かめる（run・doctor・ブラウザを使わない）。機能のファイルの手順を書いたときの確認に使う
async function checkStepsCommand(args: string[]): Promise<number> {
  const stepsPath = takeOption(args, "--steps");
  if (args.length !== 0) throw new Fail(`check-steps の引数が正しくありません: ${args.join(" ")}`);
  const steps = checkSteps(stepsPath === undefined || stepsPath === "-" ? await Bun.stdin.text() : readFileSync(stepsPath, "utf8"));
  console.log(JSON.stringify({ ok: true, steps: steps.length }));
  return 0;
}

type Playwright = typeof PlaywrightModule;

// Playwright はリポジトリの packages/web の devDependency にあり、ルートの node_modules には無い。
// この場所から静的に import できないので、packages/web から解決して browser のときだけ読み込む
async function loadPlaywright(): Promise<Playwright> {
  return (await import(Bun.resolveSync("@playwright/test", WEB_PKG))) as Playwright;
}

// 書いた項目をすべて使ってロケータを作る（使わなかった項目があれば、その手順を失敗にする）
function locate(scope: Page | Locator, spec: Spec): Locator {
  const used = new Set<string>(SPEC_COMMON);
  const use = (...keys: (keyof Spec)[]) => keys.forEach((k) => used.add(k));
  const base = spec.within ? locate(scope, spec.within) : scope;
  let loc: Locator;
  if (spec.role !== undefined) {
    use("role", "name", "exact", "level");
    loc = base.getByRole(spec.role as Parameters<Page["getByRole"]>[0], { name: spec.name, exact: spec.exact, level: spec.level });
  } else if (spec.label !== undefined) {
    use("label", "exact");
    loc = base.getByLabel(spec.label, { exact: spec.exact });
  } else if (spec.placeholder !== undefined) {
    use("placeholder", "exact");
    loc = base.getByPlaceholder(spec.placeholder, { exact: spec.exact });
  } else if (spec.text !== undefined) {
    use("text", "exact");
    loc = base.getByText(spec.text, { exact: spec.exact });
  } else if (spec.testId !== undefined) {
    use("testId");
    loc = base.getByTestId(spec.testId);
  } else {
    throw new Fail("ロケータに基点（role・label・placeholder・text・testId）がありません");
  }
  if (spec.hasText !== undefined) loc = loc.filter({ hasText: spec.hasText });
  if (spec.nth !== undefined) loc = loc.nth(spec.nth);
  const unused = Object.keys(spec).filter((k) => !used.has(k));
  if (unused.length > 0) throw new Fail(`ロケータの項目 ${unused.join(", ")} を使っていません（補助スクリプトの誤り）`);
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
  const pw = await loadPlaywright();
  // 番号は記録を書き終えるまで確保する（finally で release）
  const { dir, seq, release } = featureEvidence(p, feature);
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

  // 手順を実行する。項目は get で読み、書いてあるのに実行で読まなかった項目があれば、成功にせず失敗にする
  const run = async (pg: Page, op: Op, step: Step, rec: StepResult): Promise<void> => {
    const used = new Set<string>([op, "note"]);
    const get = <T>(key: string): T | undefined => {
      used.add(key);
      return step[key] as T | undefined;
    };
    const v = step[op];
    const loc = () => locate(pg, v as Spec);
    const { expect } = pw;
    const perform = async (): Promise<void> => {
      switch (op) {
        case "goto": {
          const target = sameOriginUrl(v as string, origin);
          if (!target) throw new Fail(`行き先 ${JSON.stringify(v)} は run の origin ${origin} の外に解けるので開きません`);
          const res = await pg.goto(target.href);
          rec.status = res?.status() ?? null;
          return;
        }
        case "reload": {
          const res = await pg.reload();
          rec.status = res?.status() ?? null;
          return;
        }
        case "url": {
          const want = sameOriginUrl(v as string, origin);
          if (!want) throw new Fail(`URL ${JSON.stringify(v)} は run の origin ${origin} の外に解けるので待ちません`);
          await pg.waitForURL((u) => u.origin === origin && u.pathname === want.pathname && (want.search === "" || u.search === want.search));
          return;
        }
        case "click":
          return loc().click();
        case "fill":
          return loc().fill(get<string>("value") as string);
        case "press": {
          const on = get<Spec>("on");
          return on ? locate(pg, on).press(v as string) : pg.keyboard.press(v as string);
        }
        case "select":
          await loc().selectOption(get<string>("value") as string);
          return;
        case "check":
          return loc().check();
        case "uncheck":
          return loc().uncheck();
        case "hover":
          return loc().hover();
        case "drag":
          return loc().dragTo(locate(pg, get<Spec>("to") as Spec));
        case "wait":
          return loc().waitFor({ state: get<"attached" | "detached" | "visible" | "hidden">("state") ?? "visible" });
        case "expect": {
          const l = loc();
          const o = { timeout };
          const count = get<number>("count");
          const hidden = get<true>("hidden");
          const text = get<string | string[]>("text");
          const value = get<string>("value");
          const attr = get<Record<string, string>>("attr");
          const disabled = get<boolean>("disabled");
          if (count !== undefined) await expect(l).toHaveCount(count, o);
          if (hidden === true) await expect(l).toBeHidden(o);
          else if (count === undefined) await expect(l).toBeVisible(o);
          if (text !== undefined) await expect(l).toContainText(text, o);
          if (value !== undefined) await expect(l).toHaveValue(value, o);
          for (const [k, want] of Object.entries(attr ?? {})) await expect(l).toHaveAttribute(k, want, o);
          if (disabled === true) await expect(l).toBeDisabled(o);
          else if (disabled === false) await expect(l).toBeEnabled(o);
          return;
        }
        case "read":
          await loc().first().waitFor();
          rec.read = await loc().allInnerTexts();
          return;
        case "snapshot":
          rec.artifact = await save(rec.index, "snapshot", v as string, { of: get<Spec>("of") });
          return;
        case "screenshot":
          rec.artifact = await save(rec.index, "screenshot", v as string, { fullPage: get<boolean>("fullPage") });
          return;
        case "events":
          // Web が出す変更通知（SSE）の接続の状態。<html data-server-events> を待つ
          await expect(pg.locator("html")).toHaveAttribute("data-server-events", v as string, { timeout });
          return;
        case "cli": {
          // ページを開いたまま、同じ run の CLI で書く。記録は <番号>-<手順>-cli.json
          const actor = get<string>("actor") ?? DEFAULT_ACTOR;
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
    await perform();
    const unused = Object.keys(step).filter((k) => !used.has(k));
    if (unused.length > 0) throw new Fail(`項目 ${unused.join(", ")} を実行で使っていません（補助スクリプトの誤り）`);
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
    release();
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
                                 検証の nod と同じデータでソースの CLI を実行する（--evidence で evidence/<機能の ID>/ に記録。引数に ui があれば拒む）
  browser <run> --feature <機能の ID> [--steps <JSON のファイル>|-] [--timeout <ミリ秒>]
                                 doctor を通してから、手順（JSON の配列。既定は標準入力）を新しいブラウザのコンテキストで実行し、
                                 evidence/<機能の ID>/ に記録・ARIA スナップショット・スクリーンショットを残す（手順の形はブラウザ・doctor の前にすべて確かめる）
  check-steps [--steps <JSON のファイル>|-]
                                 手順の形だけを確かめる（run・doctor・ブラウザを使わない）
  cleanup <run>                  自分が起動したプロセスと作業用のデータを消す（evidence/ は残す。別のプロセスには触れない。何度実行してもよい）
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
    case "check-steps":
      return checkStepsCommand(rest);
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
