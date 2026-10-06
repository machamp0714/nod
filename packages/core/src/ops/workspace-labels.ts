import type { Database } from "bun:sqlite";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import type { Workspace, WorkspaceLabel } from "../types";
import { findWorkspace } from "./workspaces";

export const LABEL_NAME_MAX_LENGTH = 50;
export const LABEL_DESCRIPTION_MAX_LENGTH = 200;

interface LabelRow {
  workspace_key: string;
  name: string;
  color: string;
  description: string;
  created_at: string;
  updated_at: string;
  issue_count: number;
}

export interface WorkspaceLabelInput {
  name: string;
  color: string;
  description?: string;
}

export interface WorkspaceLabelPatch {
  name?: string;
  color?: string;
  description?: string;
}

function requireWorkspace(db: Database, keyOrPath: string): Workspace {
  const workspace = findWorkspace(db, keyOrPath);
  if (!workspace) throw new NodError("NOT_FOUND", `Workspace ${keyOrPath} は登録されていません`);
  return workspace;
}

// 追加と変更は LLM にも許す。削除だけは人に限る
function requireHuman(ctx: OpCtx): void {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM はラベルの定義を削除できません。削除は me に依頼してください");
  }
}

// Web のラベル入力は空白と読点で区切るので、それらを含む名前は定義できない。LLM の Triage 提案（#62）のラベルも同じ規則で検証する
export function normalizeLabelName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new NodError("INVALID_ARGS", "ラベルの名前を入力してください");
  if (/[\s,、，]/.test(name)) throw new NodError("INVALID_ARGS", "ラベルの名前に空白と読点（, 、 ，）は使えません");
  if (name.length > LABEL_NAME_MAX_LENGTH) {
    throw new NodError("INVALID_ARGS", `ラベルの名前は ${LABEL_NAME_MAX_LENGTH} 文字までです`);
  }
  return name;
}

function normalizeColor(raw: string): string {
  const color = raw.trim().toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(color)) throw new NodError("INVALID_ARGS", `色は #RRGGBB の形で指定してください: ${raw}`);
  return color;
}

function normalizeDescription(raw: string | undefined): string {
  const description = (raw ?? "").trim();
  if (description.length > LABEL_DESCRIPTION_MAX_LENGTH) {
    throw new NodError("INVALID_ARGS", `ラベルの説明は ${LABEL_DESCRIPTION_MAX_LENGTH} 文字までです`);
  }
  return description;
}

const SELECT_LABELS = `
  SELECT w.key AS workspace_key, l.name, l.color, l.description, l.created_at, l.updated_at,
    (SELECT count(*) FROM issue_labels il JOIN issues i ON i.id = il.issue_id
      WHERE i.workspace_id = l.workspace_id AND il.label = l.name) AS issue_count
  FROM workspace_labels l JOIN workspaces w ON w.id = l.workspace_id`;

function toLabel(row: LabelRow): WorkspaceLabel {
  return {
    workspaceKey: row.workspace_key,
    name: row.name,
    color: row.color,
    description: row.description,
    issueCount: row.issue_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readLabel(db: Database, workspaceId: number, name: string): WorkspaceLabel | null {
  const row = db.query(`${SELECT_LABELS} WHERE l.workspace_id = ? AND l.name = ?`).get(workspaceId, name) as LabelRow | null;
  return row ? toLabel(row) : null;
}

function requireLabel(db: Database, workspace: Workspace, name: string): WorkspaceLabel {
  const label = readLabel(db, workspace.id, name);
  if (!label) throw new NodError("NOT_FOUND", `${workspace.key} にラベル ${name} は定義されていません`);
  return label;
}

function requireFreeName(db: Database, workspace: Workspace, name: string): void {
  if (readLabel(db, workspace.id, name)) {
    throw new NodError("LABEL_EXISTS", `${workspace.key} にはラベル ${name} がすでに定義されています`);
  }
}

export function listWorkspaceLabels(db: Database, keyOrPath: string): WorkspaceLabel[] {
  const workspace = requireWorkspace(db, keyOrPath);
  return (db.query(`${SELECT_LABELS} WHERE l.workspace_id = ? ORDER BY l.name`).all(workspace.id) as LabelRow[]).map(toLabel);
}

export function listAllWorkspaceLabels(db: Database): WorkspaceLabel[] {
  return (db.query(`${SELECT_LABELS} ORDER BY w.key, l.name`).all() as LabelRow[]).map(toLabel);
}

export function addWorkspaceLabel(ctx: OpCtx, keyOrPath: string, input: WorkspaceLabelInput): WorkspaceLabel {
  const name = normalizeLabelName(input.name);
  const color = normalizeColor(input.color);
  const description = normalizeDescription(input.description);
  return tx(ctx.db, () => {
    const workspace = requireWorkspace(ctx.db, keyOrPath);
    requireFreeName(ctx.db, workspace, name);
    const at = now();
    ctx.db
      .query(
        "INSERT INTO workspace_labels (workspace_id, name, color, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(workspace.id, name, color, description, at, at);
    return requireLabel(ctx.db, workspace, name);
  });
}

// 改名は、その Workspace の Issue に付いたラベルも同じトランザクションで置き換える。
// 新しい名前をすでに持つ Issue は1つにまとめる。Issue ごとの event は残さない。定期Issueのラベルも同じく置き換える
export function updateWorkspaceLabel(ctx: OpCtx, keyOrPath: string, currentName: string, patch: WorkspaceLabelPatch): WorkspaceLabel {
  const name = patch.name === undefined ? undefined : normalizeLabelName(patch.name);
  const color = patch.color === undefined ? undefined : normalizeColor(patch.color);
  const description = patch.description === undefined ? undefined : normalizeDescription(patch.description);
  return tx(ctx.db, () => {
    const workspace = requireWorkspace(ctx.db, keyOrPath);
    const current = requireLabel(ctx.db, workspace, currentName);
    const nextName = name ?? current.name;
    if (nextName !== current.name) {
      requireFreeName(ctx.db, workspace, nextName);
      ctx.db
        .query(
          `INSERT OR IGNORE INTO issue_labels (issue_id, label)
           SELECT il.issue_id, ? FROM issue_labels il JOIN issues i ON i.id = il.issue_id
           WHERE i.workspace_id = ? AND il.label = ?`,
        )
        .run(nextName, workspace.id, current.name);
      ctx.db
        .query(
          `DELETE FROM issue_labels WHERE label = ?
           AND issue_id IN (SELECT id FROM issues WHERE workspace_id = ?)`,
        )
        .run(current.name, workspace.id);
      // 定期Issueのラベルも置き換える。起票する Issue に古い名前が付かないように
      const recurring = ctx.db
        .query("SELECT id, labels FROM recurring_issues WHERE workspace_id = ?")
        .all(workspace.id) as { id: number; labels: string }[];
      for (const r of recurring) {
        const labels = JSON.parse(r.labels) as string[];
        if (!labels.includes(current.name)) continue;
        const renamed = [...new Set(labels.map((l) => (l === current.name ? nextName : l)))];
        ctx.db.query("UPDATE recurring_issues SET labels = ? WHERE id = ?").run(JSON.stringify(renamed), r.id);
      }
    }
    ctx.db
      .query("UPDATE workspace_labels SET name = ?, color = ?, description = ?, updated_at = ? WHERE workspace_id = ? AND name = ?")
      .run(nextName, color ?? current.color, description ?? current.description, now(), workspace.id, current.name);
    return requireLabel(ctx.db, workspace, nextName);
  });
}

// 定義だけを消す。Issue に付いたラベルは未定義のラベルとして残す
export function removeWorkspaceLabel(
  ctx: OpCtx,
  keyOrPath: string,
  name: string,
): { workspaceKey: string; name: string; removed: true } {
  requireHuman(ctx);
  return tx(ctx.db, () => {
    const workspace = requireWorkspace(ctx.db, keyOrPath);
    const label = requireLabel(ctx.db, workspace, name);
    ctx.db.query("DELETE FROM workspace_labels WHERE workspace_id = ? AND name = ?").run(workspace.id, label.name);
    return { workspaceKey: workspace.key, name: label.name, removed: true };
  });
}
