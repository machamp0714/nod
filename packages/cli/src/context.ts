import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findWorkspace, listAllStatusNames, NodError, type OpCtx, openDb, syncCycles, type Workspace } from "@nod/core";
import type { Command } from "commander";
import { detectActor } from "./actor";
import { useStatusNames } from "./output";

export interface Cli {
  db: Database;
  ctx: OpCtx;
  json: boolean;
}

export function globalOpts(cmd: Command): { json: boolean; workspace?: string } {
  const g = cmd.optsWithGlobals() as { json?: boolean; workspace?: string };
  return { json: Boolean(g.json), workspace: g.workspace };
}

export function openCli(cmd: Command): Cli {
  const db = openDb();
  useStatusNames(listAllStatusNames(db));
  const ctx = { db, actor: detectActor() };
  // 周期に従って Cycle を作り、終了した Cycle の未完了を持ち越す（NOD-2）。常駐処理の代わりに、コマンドのたびに確かめる
  syncCycles(ctx);
  return { db, ctx, json: globalOpts(cmd).json };
}

// git worktree の中でも、本体のリポジトリのルートを返す
export function repoRootOf(dir: string): string | null {
  try {
    const p = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (p.exitCode !== 0) return null;
    return dirname(realpathSync(p.stdout.toString().trim()));
  } catch {
    return null;
  }
}

function findByDir(db: Database, dir: string): Workspace | null {
  const root = repoRootOf(dir);
  return root ? findWorkspace(db, root) : null;
}

// -w の値（キー、登録したパス、リポジトリの中のパス）から Workspace を探す。見つからなければ null
export function findWorkspaceOpt(db: Database, w: string): Workspace | null {
  return findWorkspace(db, w) ?? findByDir(db, resolve(w));
}

export function currentWorkspace(cli: Cli, cmd: Command): Workspace {
  const w = globalOpts(cmd).workspace;
  if (w) {
    const found = findWorkspaceOpt(cli.db, w);
    if (!found) {
      throw new NodError("NOT_INITIALIZED", `Workspace ${w} は登録されていません。nod workspace list で登録済みのものを確かめてください`);
    }
    return found;
  }
  const cwd = process.cwd();
  const root = repoRootOf(cwd);
  if (!root) {
    throw new NodError(
      "NOT_INITIALIZED",
      `${cwd} は git リポジトリではありません。Workspace として登録したリポジトリの中で実行するか、-w でキーを指定してください`,
    );
  }
  const found = findWorkspace(cli.db, root);
  if (!found) throw new NodError("NOT_INITIALIZED", `${root} は Workspace として登録されていません。nod init を実行してください`);
  return found;
}

// commander の action は (...引数, options, command) を渡すので、最後の command を取り出して DB を開く
export function act<A extends unknown[]>(fn: (cli: Cli, cmd: Command, ...args: A) => void): (...all: unknown[]) => void {
  return (...all: unknown[]) => {
    const cmd = all[all.length - 1] as Command;
    fn(openCli(cmd), cmd, ...(all.slice(0, -1) as A));
  };
}

// Orca への通知のように非同期の処理を含む action 用の act
export function actAsync<A extends unknown[]>(
  fn: (cli: Cli, cmd: Command, ...args: A) => Promise<void>,
): (...all: unknown[]) => Promise<void> {
  return async (...all: unknown[]) => {
    const cmd = all[all.length - 1] as Command;
    await fn(openCli(cmd), cmd, ...(all.slice(0, -1) as A));
  };
}
