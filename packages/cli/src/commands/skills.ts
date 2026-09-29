import {
  findWorkspace,
  formatTransitionRulesSection,
  formatWorkspaceRulesSection,
  getTransitionRules,
  getWorkspaceRules,
  NodError,
  openDbReadonly,
  type WorkspaceRules,
  type WorkspaceTransitionRules,
} from "@nod/core";
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
      const { rules, transitions } = currentRules(globalOpts(cmd).workspace);
      const sections = [rules ? formatWorkspaceRulesSection(rules) : "", transitions ? formatTransitionRulesSection(transitions) : ""].filter(Boolean);
      if (sections.length === 0) {
        print(globalOpts(cmd), { name, guide }, () => guide);
        return;
      }
      const withRules = `${guide}\n${sections.join("\n")}`.trimEnd();
      const extra = { ...(rules ? { rules } : {}), ...(transitions ? { transitionRules: transitions } : {}) };
      print(globalOpts(cmd), { name, guide: withRules, ...extra }, () => withRules);
    });
}

interface CurrentRules {
  rules: WorkspaceRules | null;
  transitions: WorkspaceTransitionRules | null; // 遷移ルール（#73）。1つもなければ null
}

const NO_RULES: CurrentRules = { rules: null, transitions: null };

// -w か今いるリポジトリの Workspace に作業規約・遷移ルールがあれば返す。Workspace の外や DB を開けないときは手引きだけを出す。
// 読むだけなので、DB がなければ作らず、migration もしない（読み取り専用で開く）。
// -w の Workspace が登録されていないときは、手引きの取得を止めないよう、stderr に警告するだけにする
function currentRules(workspaceOpt: string | undefined): CurrentRules {
  const root = workspaceOpt ? null : repoRootOf(process.cwd());
  if (!workspaceOpt && !root) return NO_RULES;
  try {
    const db = openDbReadonly();
    if (!db) {
      warnUnknownWorkspace(workspaceOpt);
      return NO_RULES;
    }
    try {
      const workspace = workspaceOpt ? findWorkspaceOpt(db, workspaceOpt) : findWorkspace(db, root!);
      if (!workspace) {
        warnUnknownWorkspace(workspaceOpt);
        return NO_RULES;
      }
      return { rules: getWorkspaceRules(db, workspace.key), transitions: readTransitions(db, workspace.key) };
    } finally {
      db.close();
    }
  } catch {
    return NO_RULES;
  }
}

// migration 前の DB（遷移ルールの表がない）でも作業規約は出せるよう、失敗は「ルールなし」とする
function readTransitions(db: Parameters<typeof getTransitionRules>[0], workspaceKey: string): WorkspaceTransitionRules | null {
  try {
    const t = getTransitionRules(db, workspaceKey);
    return t.forbidden.length > 0 || t.presets.length > 0 ? t : null;
  } catch {
    return null;
  }
}

function warnUnknownWorkspace(workspaceOpt: string | undefined): void {
  if (workspaceOpt) console.error(`警告: Workspace ${workspaceOpt} は登録されていません（規約なし）`);
}
