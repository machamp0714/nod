// code-review 同梱の review.ts をプロセスとして起動するテストの共通の準備（段階ごとのテストファイルで使う）
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, registerRepo, type RunResult, runNod, tempDir } from "./helpers";

export const SKILL_DIR = join(import.meta.dir, "../../../plugins/nod/skills/code-review");
export const REVIEW_SCRIPT = join(SKILL_DIR, "scripts/review.ts");
const NOD_MAIN = join(import.meta.dir, "../src/main.ts");

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export interface ReviewRun<T> {
  exitCode: number;
  // 標準出力の1行の JSON（読めなければ undefined）。形は段階ごとのテストが T で決める
  json: T | undefined;
  stdout: string;
  stderr: string;
}
// テスト1件分の一時領域。home は HOME、bin は PATH の先頭に足す偽コマンドの置き場、env は子プロセスへ渡す環境変数
export interface Sandbox {
  t: string;
  home: string;
  bin: string;
  env: Record<string, string>;
}

export function sandbox(): Sandbox {
  const t = tempDir("nod-review-");
  const home = join(t, "home");
  const bin = join(t, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const env: Record<string, string> = { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, NOD_ORCA: "0" };
  return { t, home, bin, env };
}

// review.ts <subcommand> ... を起動する。CLAUDECODE などの外の環境に左右されないよう、テストの env で上書きする
export async function runReview<T>(sub: string, args: string[], s: Sandbox, extraEnv: Record<string, string> = {}): Promise<ReviewRun<T>> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDECODE: undefined, NOD_ACTOR: undefined, ...s.env, ...extraEnv };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const proc = Bun.spawn([process.execPath, REVIEW_SCRIPT, sub, ...args], { cwd: s.t, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let json: T | undefined;
  try {
    json = JSON.parse(stdout) as T;
  } catch {
    json = undefined;
  }
  return { exitCode, json, stdout, stderr };
}

export function put(path: string, body: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

// 一時の Git リポジトリ（main に最初の commit）。名前は日本語を含められる
export function makeGitRepo(s: Sandbox, name = "app"): string {
  const repo = join(s.t, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  put(join(repo, "README.md"), "# app\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

// files を書いて commit し、その SHA を返す
export function commit(repo: string, files: Record<string, string>, message = "change"): string {
  for (const [path, body] of Object.entries(files)) put(join(repo, path), body);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return gitOut(repo, "rev-parse", "HEAD");
}

export function gitOut(cwd: string, ...args: string[]): string {
  const p = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (p.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${p.stderr}`);
  return p.stdout.trim();
}

// dir の配下のすべてのファイルとリンク（リンクは辿らない）の相対パス
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const walk = (p: string, rel: string) => {
    const st = lstatSync(p);
    if (st.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name), rel ? `${rel}/${name}` : name);
    else out.push(rel);
  };
  walk(dir, "");
  return out.sort();
}

// dir の配下のどこかのファイルに needle が含まれるか（リンクは辿らない）
export function anyFileContains(dir: string, needle: string): string[] {
  return filesUnder(dir).filter((rel) => {
    const p = join(dir, rel);
    return lstatSync(p).isFile() && readFileSync(p).includes(needle);
  });
}

// parent.md の指紋の取り方をそのままシェルで行う（スクリプトの実装とは独立の正解）
export function shellFingerprint(dir: string, opts: { exclude?: string; links?: boolean } = {}): string {
  const exclude = opts.exclude ? ` ! -path ./${opts.exclude}` : "";
  const files = `find . -type f${exclude} -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256`;
  const links = `find . -type l -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' l; do printf 'link %s -> %s\\n' "$l" "$(readlink "$l")"; done`;
  const p = spawnSync("bash", ["-c", opts.links ? `${files} && ${links}` : files], { cwd: dir, encoding: "utf8" });
  if (p.status !== 0) throw new Error(p.stderr);
  return p.stdout;
}

// 偽のパッケージ管理コマンド（bun・npm・pnpm・yarn・node）。ネットワークを使わず、引数と作業ディレクトリを log に残し、
// node_modules にファイルとリンクを作る。FAKE_PM_FAIL があれば準備の失敗（終了コード 7）を返す
export function fakePackageManager(s: Sandbox, name: string): { log: () => string[] } {
  const log = join(s.t, `${name}.log`);
  const path = join(s.bin, name);
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `printf '%s|%s\\n' "$(pwd)" "$*" >> "${log}"`,
      'for a in "$@"; do case "$a" in --version) echo 9.9.9-fake; exit 0;; config) echo https://registry.example.invalid/; exit 0;; esac; done',
      'if [ -n "$FAKE_PM_FAIL" ]; then echo "install failed" >&2; exit 7; fi',
      "mkdir -p node_modules/left-pad node_modules/.bin packages/web/node_modules/tiny",
      "printf 'module.exports = 1;\\n' > node_modules/left-pad/index.js",
      "printf 'tiny\\n' > packages/web/node_modules/tiny/index.js",
      "ln -s ../left-pad/index.js node_modules/.bin/left-pad",
      "ln -s ../../packages/web node_modules/web",
      "echo installed",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return { log: () => (existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : []) };
}

// 一時の nod の DB と Document の置き場。NOD_CLI には main.ts を実行する一時のシェルスクリプトを渡す
export interface TempNod {
  db: string;
  docs: string;
  env: Record<string, string>;
  run: (args: string[], cwd: string) => Promise<RunResult>;
}

export function tempNod(s: Sandbox): TempNod {
  const db = join(s.t, "nod-db", "nod.db");
  const docs = join(s.t, "nod-docs");
  mkdirSync(dirname(db), { recursive: true });
  mkdirSync(docs, { recursive: true });
  const cli = join(s.t, "nod-cli.sh");
  writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "${NOD_MAIN}" "$@"\n`);
  chmodSync(cli, 0o755);
  const env = { NOD_CLI: cli, NOD_DB: db, NOD_DOCS_DIR: docs, NOD_ORCA: "0" };
  Object.assign(s.env, env);
  return { db, docs, env, run: (args, cwd) => runNod(args, { cwd, db, env: { NOD_DOCS_DIR: docs, HOME: s.home } }) };
}

export { git, registerRepo };
