import { findWorkspace, formatWorkspaceRulesSection, getWorkspaceRules, NodError, openDbReadonly, type WorkspaceRules } from "@nod/core";
import type { Command } from "commander";
import { findWorkspaceOpt, globalOpts, repoRootOf } from "../context";
import { GUIDE } from "../guide";
import { print } from "../output";

const SKILLS = new Map<string, string>([["nod", GUIDE]]);

export function registerSkillsCommands(program: Command): void {
  const skills = program.command("skills").description("LLM 向けの手引きを出力する");
  skills
    .command("get <name>")
    .description("手引きを出力する")
    .action((name: string, _o: unknown, cmd: Command) => {
      const guide = SKILLS.get(name);
      if (!guide) {
        throw new NodError("UNKNOWN_SKILL", `手引き ${name} はありません（あるもの: ${[...SKILLS.keys()].join(", ")}）`);
      }
      const rules = currentRules(globalOpts(cmd).workspace);
      if (!rules) {
        print(globalOpts(cmd), { name, guide }, () => guide);
        return;
      }
      const withRules = `${guide}\n${formatWorkspaceRulesSection(rules)}`.trimEnd();
      print(globalOpts(cmd), { name, guide: withRules, rules }, () => withRules);
    });
}

// -w か今いるリポジトリの Workspace に作業規約があれば返す。Workspace の外や DB を開けないときは手引きだけを出す。
// 読むだけなので、DB がなければ作らず、migration もしない（読み取り専用で開く）。
// -w の Workspace が登録されていないときは、手引きの取得を止めないよう、stderr に警告するだけにする
function currentRules(workspaceOpt: string | undefined): WorkspaceRules | null {
  const root = workspaceOpt ? null : repoRootOf(process.cwd());
  if (!workspaceOpt && !root) return null;
  try {
    const db = openDbReadonly();
    if (!db) {
      warnUnknownWorkspace(workspaceOpt);
      return null;
    }
    try {
      const workspace = workspaceOpt ? findWorkspaceOpt(db, workspaceOpt) : findWorkspace(db, root!);
      if (!workspace) {
        warnUnknownWorkspace(workspaceOpt);
        return null;
      }
      return getWorkspaceRules(db, workspace.key);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function warnUnknownWorkspace(workspaceOpt: string | undefined): void {
  if (workspaceOpt) console.error(`警告: Workspace ${workspaceOpt} は登録されていません（規約なし）`);
}
