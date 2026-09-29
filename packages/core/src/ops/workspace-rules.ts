import type { Database } from "bun:sqlite";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import type { Workspace, WorkspaceRules } from "../types";
import { findWorkspace } from "./workspaces";

// 上限の「文字」はコードポイントで数える（絵文字などのサロゲートペアも1文字）。web の rulesEditState も同じ数え方
export const RULES_MAX_LENGTH = 10000;

interface RulesRow {
  rules: string | null;
  rules_updated_at: string | null;
  rules_updated_by: string | null;
}

function requireWorkspace(db: Database, keyOrPath: string): Workspace {
  const workspace = findWorkspace(db, keyOrPath);
  if (!workspace) throw new NodError("NOT_FOUND", `Workspace ${keyOrPath} は登録されていません`);
  return workspace;
}

function requireHuman(ctx: OpCtx): void {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は作業規約を登録・更新・削除できません。変更は me に依頼してください");
  }
}

function readRules(db: Database, workspace: Workspace): WorkspaceRules | null {
  const row = db
    .query("SELECT rules, rules_updated_at, rules_updated_by FROM workspaces WHERE id = ?")
    .get(workspace.id) as RulesRow;
  if (row.rules === null) return null;
  return { workspaceKey: workspace.key, body: row.rules, updatedAt: row.rules_updated_at ?? "", updatedBy: row.rules_updated_by ?? "" };
}

export function getWorkspaceRules(db: Database, keyOrPath: string): WorkspaceRules | null {
  return readRules(db, requireWorkspace(db, keyOrPath));
}

// 前後の空白を落として保存する。空になれば削除として扱い null を返す
export function setWorkspaceRules(ctx: OpCtx, keyOrPath: string, body: string): WorkspaceRules | null {
  requireHuman(ctx);
  const trimmed = body.trim();
  const length = [...trimmed].length;
  if (length > RULES_MAX_LENGTH) {
    throw new NodError(
      "INVALID_ARGS",
      `作業規約は ${RULES_MAX_LENGTH.toLocaleString("en-US")} 文字までです（${length.toLocaleString("en-US")} 文字）`,
    );
  }
  return tx(ctx.db, () => {
    const workspace = requireWorkspace(ctx.db, keyOrPath);
    if (!trimmed) {
      ctx.db.query("UPDATE workspaces SET rules = NULL, rules_updated_at = NULL, rules_updated_by = NULL WHERE id = ?").run(workspace.id);
      return null;
    }
    ctx.db
      .query("UPDATE workspaces SET rules = ?, rules_updated_at = ?, rules_updated_by = ? WHERE id = ?")
      .run(trimmed, now(), ctx.actor, workspace.id);
    return readRules(ctx.db, workspace);
  });
}

export function clearWorkspaceRules(ctx: OpCtx, keyOrPath: string): { workspaceKey: string; cleared: true } {
  setWorkspaceRules(ctx, keyOrPath, "");
  return { workspaceKey: requireWorkspace(ctx.db, keyOrPath).key, cleared: true };
}

// LLM 向けの出力に添える作業規約の節。未登録なら空文字
export function formatWorkspaceRulesSection(rules: WorkspaceRules | null): string {
  if (!rules) return "";
  return `## この Workspace の作業規約（${rules.workspaceKey}）\n\n人が登録した規約である。作業中は必ず守る。LLM は規約を変更できない。\n\n${rules.body}\n`;
}
