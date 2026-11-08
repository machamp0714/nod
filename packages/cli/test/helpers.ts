import { setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace, openDb } from "@nod/core";

// Bun 1.3.5 は bunfig.toml の [test] timeout を読まないため、ここで既定のタイムアウトを延ばす
setDefaultTimeout(30000);

const MAIN = join(import.meta.dir, "../src/main.ts");

// 偽レビューモデルのスクリプト断片。`input` を読んだ後に置き、旧来の詳細形式で要求を返すモデルとして
// 固定資料ファイル（sources[].path）を読み、確認単位の出典へhash・引用を補う。入力自体は索引だけを持つ。
export const echoReviewReferences = `for (const u of input.reviewUnits ?? []) { const body = require("node:fs").readFileSync(input.sources.find(s => s.source === u.reference.source).path, "utf8"); u.reference = { ...u.reference, hash: require("node:crypto").createHash("sha256").update(body).digest("hex"), quote: body.split("\\n")[u.reference.line - 1] }; }`;

// macOS の一時ディレクトリは /var が /private/var へのシンボリックリンクなので、実体のパスにそろえる
export function tempDir(prefix = "nod-cli-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function tempDb(): string {
  return join(tempDir("nod-db-"), "nod.db");
}

// 利用者の git の設定（署名、フック）に左右されないようにする
export function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=nod",
      "-c",
      "user.email=nod@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
}

export function makeRepo(name = "api-server"): string {
  const dir = join(tempDir(), name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

export function addWorktree(repo: string, branch: string): string {
  const wt = join(tempDir("nod-wt-"), branch);
  git(repo, "worktree", "add", "-q", wt, "-b", branch);
  return realpathSync(wt);
}

// nod init は Task 10 で作るため、core で直接登録する
export function registerRepo(db: string, repo: string, key?: string): void {
  const d = openDb(db);
  initWorkspace(d, { path: repo, key });
  d.close();
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  json: any;
}

export async function runNod(
  args: string[],
  opts: { cwd: string; db: string; actor?: string; env?: Record<string, string> },
): Promise<RunResult> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDECODE: undefined,
    NOD_ACTOR: opts.actor,
    NOD_DB: opts.db,
    NOD_ORCA: "0",
    ...opts.env,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const proc = Bun.spawn(["bun", MAIN, ...args], { cwd: opts.cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { stdout, stderr, exitCode, json };
}
