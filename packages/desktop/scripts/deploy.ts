// desktop:deploy — ビルドから入れ替え・起動・版の確認までを 1 コマンドで行う（初回導入も更新も同じ）。
//   bun run desktop:deploy [--applications-dir <dir>] [--wrapper <path>] [--archive-dir <dir>] ...
// 配置先・ラッパー・退避先・旧配置・ビルドコマンド・DB・待機上限は、引数か環境変数で差し替えられる（下の resolveConfig）。
// 強制終了（kill）はしない。アプリには通常の終了（AppleScript quit）を依頼するだけで、止まらなければ中止する。
import {
  chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultDbPath } from "../../core/src/db";

export const BUNDLE_ID = "io.github.machamp0714.nod";
export const APP_NAME = "nod.app";

export interface DeployConfig {
  repoRoot: string;
  /** desktop:build の成果物 */
  appSrc: string;
  /** 新しい .app を置くディレクトリ（~/Applications） */
  applicationsDir: string;
  /** ~/.local/bin/nod */
  wrapperPath: string;
  /** 旧 .app・旧ラッパー・旧配置の退避先 */
  archiveDir: string;
  /** 旧配置（nod, VERSION, web を置いた ~/.local/share/nod-app） */
  legacyDir: string;
  /** sh -c に渡すビルドコマンド */
  buildCommand: string;
  dbPath: string;
  quitTimeoutMs: number;
  launchTimeoutMs: number;
  /** 退避した .app を残す世代数 */
  keep: number;
}

export interface ProcessInfo {
  pid: number;
  command: string;
}

export interface BuildInfoLite {
  version: string;
  commit: string;
  dirty: boolean;
}

export interface LaunchVerification {
  ok: boolean;
  /** 人に見せる結果の行 */
  lines: string[];
}

export interface DeployDeps {
  log(line: string): void;
  /** `git status --porcelain`（gitignore 済みは含まれない） */
  gitStatus(): string;
  gitHead(): string;
  listProcesses(): ProcessInfo[];
  /** sh -c <buildCommand> を実行し、終了コードを返す */
  runBuild(command: string): number;
  isAppRunning(appPath: string): boolean;
  /** 通常の終了を依頼する（強制終了ではない） */
  requestQuit(): void;
  sleep(ms: number): Promise<void>;
  now(): Date;
  launchApp(appPath: string): void;
  /** 起動後の確認。sidecar の URL の特定・/api/workspaces・nod --version の一致 */
  verifyLaunch(ctx: { appPath: string; wrapperPath: string; timeoutMs: number; expected: BuildInfoLite }): Promise<LaunchVerification>;
}

export type DeployOutcome =
  | "ok"
  | "aborted-precondition"
  | "aborted-build"
  | "aborted-quit-timeout"
  | "aborted-install"
  | "rolled-back"
  | "needs-manual-restore";

export interface DeployResult {
  ok: boolean;
  outcome: DeployOutcome;
}

// ---- 純粋な補助関数（テスト対象） ----

// 手動の `nod ui`。.app 自身の sidecar（…/nod.app/Contents/MacOS/nod ui …）は除く
export function isManualNodUi(command: string): boolean {
  if (/\.app\/Contents\/MacOS\/nod(\s|$)/.test(command)) return false;
  return /(?:^|\/)nod\s+ui(?:\s|$)/.test(command) || /cli\/src\/main\.ts\s+ui(?:\s|$)/.test(command);
}

export function parsePs(output: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), command: m[2]! });
  }
  return out;
}

// 指定した .app の sidecar（Contents/MacOS/nod ui …）
export function findAppSidecars(procs: ProcessInfo[], appPaths: string[]): ProcessInfo[] {
  return procs.filter((p) =>
    appPaths.some((a) => p.command.startsWith(`${a}/Contents/MacOS/nod `) || p.command === `${a}/Contents/MacOS/nod`),
  );
}

// `lsof -Fn` の出力から LISTEN しているポートを取り出す
export function parseLsofListen(output: string): number[] {
  const ports: number[] = [];
  for (const line of output.split("\n")) {
    const m = /^n.*:(\d+)$/.exec(line.trim());
    if (m) ports.push(Number(m[1]));
  }
  return [...new Set(ports)];
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// .app 内の sidecar へ exec するラッパー。cwd は変えない。ui のときだけ .app の web を渡す（--web-dir があれば足さない）
export function wrapperContent(appPath: string): string {
  return [
    "#!/bin/bash",
    "# nod: nod.app 内の sidecar を実行する（bun run desktop:deploy が生成する。手で編集しない）",
    `APP=${shellQuote(appPath)}`,
    'BIN="$APP/Contents/MacOS/nod"',
    'if [ "$1" = "ui" ] && [[ " $* " != *" --web-dir"* ]]; then',
    '  shift; exec "$BIN" ui --web-dir "$APP/Contents/Resources/web" "$@"',
    "fi",
    'exec "$BIN" "$@"',
    "",
  ].join("\n");
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, ""); // 20261010T123456789Z
}

const ARCHIVE_APP = /^nod-(\d{8}T\d{9}Z)-.+\.app$/;

function readBuildInfo(app: string): BuildInfoLite | null {
  try {
    const j = JSON.parse(readFileSync(join(app, "Contents", "Resources", "build-info"), "utf8")) as Partial<BuildInfoLite>;
    if (typeof j.version !== "string" || typeof j.commit !== "string") return null;
    return { version: j.version, commit: j.commit, dirty: j.dirty === true };
  } catch {
    return null;
  }
}

// DB の隣の backups/ の世代一覧（migration が走ったかを、実行前後の差で判定する）
export function listBackups(dbPath: string): string[] {
  try {
    return readdirSync(join(dirname(dbPath), "backups")).filter((n) => !n.startsWith(".")).sort();
  } catch {
    return [];
  }
}

function moveDir(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as { code?: string }).code !== "EXDEV") throw e;
    copyApp(from, to);
    rmSync(from, { recursive: true, force: true });
  }
}

// 隔離（quarantine）属性が付かない複製。署名とパーミッションを保つため ditto を使う
function copyApp(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  const r = Bun.spawnSync(["ditto", "--noqtn", from, to], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  }
  Bun.spawnSync(["xattr", "-dr", "com.apple.quarantine", to], { stdout: "pipe", stderr: "pipe" });
}

function writeExecutable(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  chmodSync(tmp, 0o755);
  renameSync(tmp, path);
}

function pruneArchive(archiveDir: string, keep: number): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(archiveDir).filter((n) => ARCHIVE_APP.test(n)).sort((a, b) =>
      ARCHIVE_APP.exec(a)![1]!.localeCompare(ARCHIVE_APP.exec(b)![1]!),
    );
  } catch {}
  const drop = names.slice(0, Math.max(0, names.length - keep));
  for (const n of drop) rmSync(join(archiveDir, n), { recursive: true, force: true });
  return drop;
}

// ---- 本体 ----

export async function deploy(cfg: DeployConfig, deps: DeployDeps): Promise<DeployResult> {
  const log = deps.log;
  const abort = (outcome: DeployOutcome, msg: string): DeployResult => {
    log(`\n中止: ${msg}`);
    return { ok: false, outcome };
  };

  // 1. 前提
  const dirty = deps.gitStatus().trim();
  if (dirty) {
    return abort(
      "aborted-precondition",
      `作業ツリーに未コミットの変更があります（build-info の commit を確定させるため）。コミットしてから実行してください。\n${dirty}`,
    );
  }
  const manual = deps.listProcesses().filter((p) => isManualNodUi(p.command));
  if (manual.length > 0) {
    return abort(
      "aborted-precondition",
      `手動の nod ui が稼働中です。止めずに中止します。自分で止めてから再実行してください。\n${manual.map((p) => `  pid ${p.pid}: ${p.command}`).join("\n")}`,
    );
  }

  // 2. ビルド（検査は desktop:build の最後で行われ、通らなければ成果物は作られない）
  log(`ビルド: ${cfg.buildCommand}`);
  const code = deps.runBuild(cfg.buildCommand);
  if (code !== 0) return abort("aborted-build", `ビルドが失敗しました（終了コード ${code}）。何も入れ替えていません。`);
  const built = readBuildInfo(cfg.appSrc);
  if (!built) return abort("aborted-build", `成果物または build-info がありません: ${cfg.appSrc}`);
  const head = deps.gitHead();
  if (built.commit !== head || built.dirty) {
    return abort(
      "aborted-build",
      `成果物の build-info が HEAD と一致しません（commit ${built.commit.slice(0, 7)}、dirty ${built.dirty}。HEAD は ${head.slice(0, 7)}）。`,
    );
  }

  const target = join(cfg.applicationsDir, APP_NAME);

  // 3. 稼働中のアプリの終了（通常の終了の依頼のみ。強制終了しない）
  const stopped = await quitAndWait(cfg, deps, target);
  if (!stopped) {
    return abort(
      "aborted-quit-timeout",
      `アプリが ${cfg.quitTimeoutMs}ms 以内に終了しませんでした。強制終了はしません。自分で終了してから再実行してください。`,
    );
  }

  // 4. 旧 .app の退避と新 .app の配置
  const backupsBefore = listBackups(cfg.dbPath);
  const now = deps.now();
  let archivedOld: string | null = null;
  let oldWrapper: string | null = null;
  let wrapperArchive: string | null = null;
  let wrapperChanged = false;
  let placed = false;
  const staging = join(cfg.applicationsDir, `.nod.app.new-${process.pid}`);

  const rollbackFiles = (): void => {
    rmSync(staging, { recursive: true, force: true });
    if (wrapperChanged) {
      if (oldWrapper !== null) writeExecutable(cfg.wrapperPath, oldWrapper);
      else rmSync(cfg.wrapperPath, { force: true });
      if (wrapperArchive) rmSync(wrapperArchive, { force: true });
    }
    if (placed) rmSync(target, { recursive: true, force: true });
    if (archivedOld) moveDir(archivedOld, target);
  };

  try {
    mkdirSync(cfg.applicationsDir, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    copyApp(cfg.appSrc, staging);
    if (existsSync(target)) {
      const oldVersion = readBuildInfo(target)?.version ?? "unknown";
      let dest = join(cfg.archiveDir, `nod-${stamp(now)}-${oldVersion}.app`);
      for (let i = 1; existsSync(dest); i++) dest = join(cfg.archiveDir, `nod-${stamp(now)}-${oldVersion}-${i}.app`);
      moveDir(target, dest);
      archivedOld = dest;
      log(`旧 .app を退避しました: ${dest}`);
    }
    renameSync(staging, target);
    placed = true;
    log(`新しい .app を置きました: ${target}`);

    // 5. ラッパー（同じ内容なら何もしない）
    const wanted = wrapperContent(target);
    oldWrapper = existsSync(cfg.wrapperPath) ? readFileSync(cfg.wrapperPath, "utf8") : null;
    if (oldWrapper === wanted) {
      log(`ラッパーは最新です: ${cfg.wrapperPath}`);
    } else {
      if (oldWrapper !== null) {
        wrapperArchive = join(cfg.archiveDir, `nod-wrapper-${stamp(now)}`);
        mkdirSync(cfg.archiveDir, { recursive: true });
        writeFileSync(wrapperArchive, oldWrapper);
        chmodSync(wrapperArchive, 0o755);
      }
      wrapperChanged = true;
      writeExecutable(cfg.wrapperPath, wanted);
      log(`ラッパーを書き換えました: ${cfg.wrapperPath}${wrapperArchive ? `（旧: ${wrapperArchive}）` : ""}`);
    }
  } catch (e) {
    try {
      rollbackFiles();
    } catch (e2) {
      return abort("aborted-install", `入れ替え中に失敗し、戻す処理にも失敗しました: ${e} / ${e2}`);
    }
    return abort("aborted-install", `入れ替え中に失敗したため、元に戻しました: ${e instanceof Error ? e.message : e}`);
  }

  // 6. 起動と確認
  log(`\nアプリを起動します: ${target}`);
  let verification: LaunchVerification;
  try {
    deps.launchApp(target);
    verification = await deps.verifyLaunch({
      appPath: target, wrapperPath: cfg.wrapperPath, timeoutMs: cfg.launchTimeoutMs, expected: built,
    });
  } catch (e) {
    verification = { ok: false, lines: [`起動の確認で例外: ${e instanceof Error ? e.message : String(e)}`] };
  }
  for (const l of verification.lines) log(`  ${l}`);

  if (verification.ok) {
    // 旧配置の退避（初回のみ。成功が確認できてから動かす。データ・DB は動かさない）
    if (existsSync(cfg.legacyDir)) {
      const dest = join(cfg.archiveDir, `nod-app-${stamp(now)}`);
      try {
        moveDir(cfg.legacyDir, dest);
        log(`旧配置を退避しました: ${dest}`);
      } catch (e) {
        log(`注意: 旧配置を退避できませんでした（${cfg.legacyDir}）: ${e}`);
      }
    }
    const dropped = pruneArchive(cfg.archiveDir, cfg.keep);
    if (dropped.length > 0) log(`古い退避を削除しました（最新 ${cfg.keep} 件を保持）: ${dropped.join(", ")}`);
    log(`\n完了: version ${built.version} / commit ${built.commit.slice(0, 7)}`);
    return { ok: true, outcome: "ok" };
  }

  // 失敗: migration（backups/ の増加）が走ったかで分ける
  const before = new Set(backupsBefore);
  const added = listBackups(cfg.dbPath).filter((n) => !before.has(n));
  if (added.length > 0) {
    log(
      [
        "",
        "起動の確認に失敗しました。この実行で DB の migration が走ったため、自動では戻しません（旧版では DB を開けない可能性があります）。",
        `  新しいバックアップ: ${added.map((n) => join(dirname(cfg.dbPath), "backups", n)).join(", ")}`,
        "手動の復元手順:",
        "  1. アプリを終了する",
        `  2. 退避した旧 .app を戻す: ${archivedOld ?? "（旧 .app はありませんでした。旧配置の " + cfg.legacyDir + " と旧ラッパーが対象です）"}`,
        `  3. 旧版で DB を開けなければ、上のバックアップの DB を ${cfg.dbPath} へ戻す`,
        `  4. ${cfg.dbPath}-wal と ${cfg.dbPath}-shm を削除する`,
        ...(wrapperArchive ? [`  旧ラッパーは ${wrapperArchive} にあります`] : []),
      ].join("\n"),
    );
    return { ok: false, outcome: "needs-manual-restore" };
  }

  // 戻す前に、起動したアプリへ通常の終了を依頼する
  log("\n起動の確認に失敗しました。migration は走っていないため、旧版へ戻します。");
  if (!(await quitAndWait(cfg, deps, target))) {
    log(
      `アプリが終了しないため、入れ替えを戻せませんでした（強制終了はしません）。終了してから ${target} を ${archivedOld ?? "旧版"} に差し替えてください。`,
    );
    return { ok: false, outcome: "needs-manual-restore" };
  }
  try {
    rollbackFiles();
  } catch (e) {
    log(`戻す処理に失敗しました: ${e}。退避先: ${archivedOld ?? cfg.archiveDir}`);
    return { ok: false, outcome: "needs-manual-restore" };
  }
  log(`旧版へ戻しました${archivedOld ? `: ${target}` : "（旧 .app はなく、旧ラッパーへ戻しました）"}`);
  return { ok: false, outcome: "rolled-back" };
}

async function quitAndWait(cfg: DeployConfig, deps: DeployDeps, appPath: string): Promise<boolean> {
  if (!deps.isAppRunning(appPath)) return true;
  deps.log(`稼働中のアプリへ終了を依頼します（上限 ${cfg.quitTimeoutMs}ms）`);
  deps.requestQuit();
  const deadline = Date.now() + cfg.quitTimeoutMs;
  while (Date.now() < deadline) {
    await deps.sleep(Math.min(250, Math.max(10, cfg.quitTimeoutMs / 10)));
    if (!deps.isAppRunning(appPath)) return true;
  }
  return !deps.isAppRunning(appPath);
}

// ---- 実環境の依存 ----

function capture(cmd: string[], cwd?: string): { code: number; stdout: string } {
  try {
    const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString() };
  } catch {
    return { code: -1, stdout: "" };
  }
}

function psList(): ProcessInfo[] {
  return parsePs(capture(["ps", "-axo", "pid=,command="]).stdout);
}

function sidecarPorts(pid: number): number[] {
  return parseLsofListen(capture(["lsof", "-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]).stdout);
}

// 起動後の .app の sidecar の LISTEN ポートを、ps と lsof の実測で求める（ログには頼らない）
export async function discoverSidecarUrl(
  appPath: string,
  timeoutMs: number,
  env: { ps?: () => ProcessInfo[]; ports?: (pid: number) => number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string | null> {
  const ps = env.ps ?? psList;
  const ports = env.ports ?? sidecarPorts;
  const sleep = env.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const paths = [appPath];
  try {
    paths.push(realpathSync(appPath));
  } catch {}
  const deadline = Date.now() + timeoutMs;
  do {
    for (const p of findAppSidecars(ps(), paths)) {
      const found = ports(p.pid);
      if (found.length > 0) return `http://127.0.0.1:${found[0]}`;
    }
    await sleep(300);
  } while (Date.now() < deadline);
  return null;
}

async function realVerifyLaunch(ctx: {
  appPath: string; wrapperPath: string; timeoutMs: number; expected: BuildInfoLite;
}): Promise<LaunchVerification> {
  const lines: string[] = [];
  let ok = true;
  const fail = (s: string) => {
    ok = false;
    lines.push(`FAIL ${s}`);
  };
  const installed = readBuildInfo(ctx.appPath);
  if (!installed || installed.version !== ctx.expected.version) {
    fail(`配置した .app の build-info の版が ${installed?.version ?? "（読めない）"}、期待は ${ctx.expected.version}`);
  } else {
    lines.push(`ok   build-info: version ${installed.version} / commit ${installed.commit.slice(0, 7)}`);
  }
  const url = await discoverSidecarUrl(ctx.appPath, ctx.timeoutMs);
  if (!url) {
    fail(`${ctx.timeoutMs}ms 以内に .app の sidecar の LISTEN ポートが見つかりませんでした`);
  } else {
    try {
      const res = await fetch(new URL("/api/workspaces", url), { signal: AbortSignal.timeout(5000) });
      if (res.status === 200) lines.push(`ok   ${url} の /api/workspaces が 200`);
      else fail(`${url} の /api/workspaces が ${res.status}`);
    } catch (e) {
      fail(`${url} の /api/workspaces に接続できません: ${e}`);
    }
  }
  const v = capture([ctx.wrapperPath, "--version"]);
  const got = v.stdout.trim();
  if (v.code === 0 && got === ctx.expected.version) lines.push(`ok   nod --version（ラッパー経由）= ${got}`);
  else fail(`nod --version（ラッパー経由）は「${got || `終了コード ${v.code}`}」、期待は「${ctx.expected.version}」`);
  return { ok, lines };
}

export function realDeps(cfg: DeployConfig): DeployDeps {
  return {
    log: (l) => console.log(l),
    gitStatus: () => capture(["git", "status", "--porcelain"], cfg.repoRoot).stdout,
    gitHead: () => capture(["git", "rev-parse", "HEAD"], cfg.repoRoot).stdout.trim(),
    listProcesses: psList,
    runBuild: (command) => {
      const r = Bun.spawnSync(["sh", "-c", command], { cwd: cfg.repoRoot, stdout: "inherit", stderr: "inherit" });
      return r.exitCode ?? -1;
    },
    isAppRunning: (appPath) => {
      const r = capture(["osascript", "-e", `application id "${BUNDLE_ID}" is running`]);
      if (r.code === 0 && r.stdout.trim() === "true") return true;
      const procs = psList();
      return procs.some((p) => p.command.startsWith(`${appPath}/Contents/MacOS/nod-desktop`)) ||
        findAppSidecars(procs, [appPath]).length > 0;
    },
    requestQuit: () => {
      capture(["osascript", "-e", `tell application id "${BUNDLE_ID}" to quit`]);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    launchApp: (appPath) => {
      const r = capture(["open", appPath]);
      if (r.code !== 0) throw new Error(`open ${appPath} が失敗しました`);
    },
    verifyLaunch: realVerifyLaunch,
  };
}

// ---- 設定 ----

const OPTION_KEYS: Record<string, keyof DeployConfig> = {
  "--app-src": "appSrc",
  "--applications-dir": "applicationsDir",
  "--wrapper": "wrapperPath",
  "--archive-dir": "archiveDir",
  "--legacy-dir": "legacyDir",
  "--build-command": "buildCommand",
  "--db": "dbPath",
  "--quit-timeout-ms": "quitTimeoutMs",
  "--launch-timeout-ms": "launchTimeoutMs",
  "--keep": "keep",
};

export function resolveConfig(
  argv: string[] = [],
  env: Record<string, string | undefined> = process.env,
  repoRoot: string = resolve(import.meta.dir, "..", "..", ".."),
): DeployConfig {
  const home = homedir();
  const e = (k: string) => env[`NOD_DEPLOY_${k}`] || undefined;
  const cfg: DeployConfig = {
    repoRoot,
    appSrc: e("APP_SRC") ?? join(repoRoot, "packages", "desktop", "dist", APP_NAME),
    applicationsDir: e("APPLICATIONS_DIR") ?? join(home, "Applications"),
    wrapperPath: e("WRAPPER") ?? join(home, ".local", "bin", "nod"),
    archiveDir: e("ARCHIVE_DIR") ?? join(home, ".local", "share", "nod-app-archive"),
    legacyDir: e("LEGACY_DIR") ?? join(home, ".local", "share", "nod-app"),
    buildCommand: e("BUILD_CMD") ?? "bun run desktop:build",
    dbPath: defaultDbPath(env),
    quitTimeoutMs: Number(e("QUIT_TIMEOUT_MS") ?? 30000),
    launchTimeoutMs: Number(e("LAUNCH_TIMEOUT_MS") ?? 30000),
    keep: Number(e("KEEP") ?? 3),
  };
  for (let i = 0; i < argv.length; i++) {
    const key = OPTION_KEYS[argv[i]!];
    const val = argv[i + 1];
    if (!key || val === undefined) throw new Error(`不明な引数、または値がありません: ${argv[i]}`);
    (cfg as unknown as Record<string, unknown>)[key] =
      typeof cfg[key] === "number" ? Number(val) : val;
    i++;
  }
  return cfg;
}

if (import.meta.main) {
  try {
    const cfg = resolveConfig(process.argv.slice(2));
    const r = await deploy(cfg, realDeps(cfg));
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
