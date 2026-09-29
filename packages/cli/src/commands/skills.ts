import { findWorkspace, formatWorkspaceRulesSection, getWorkspaceRules, NodError, openDb, type WorkspaceRules } from "@nod/core";
import type { Command } from "commander";
import { globalOpts, repoRootOf } from "../context";
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
      const withRules = `${guide}\n${formatWorkspaceRulesSection(rules)}`;
      print(globalOpts(cmd), { name, guide: withRules, rules }, () => withRules);
    });
}

// -w か今いるリポジトリの Workspace に作業規約があれば返す。Workspace の外や DB を開けないときは手引きだけを出す
function currentRules(workspaceOpt: string | undefined): WorkspaceRules | null {
  const target = workspaceOpt ?? repoRootOf(process.cwd());
  if (!target) return null;
  try {
    const db = openDb();
    try {
      const workspace = findWorkspace(db, target);
      return workspace ? getWorkspaceRules(db, workspace.key) : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
