import type { Database } from "bun:sqlite";
import { isLlm, type OpCtx } from "./ctx";
import { tx } from "./db";
import { NodError } from "./errors";
import { findWorkspace } from "./ops/workspaces";
import { STATUSES, type Status, type Workspace } from "./types";

// spec の UI 表示ラベル。Workspace で表示名を設定していないステータスはこれを表示する
export const DEFAULT_STATUS_LABELS: Record<Status, string> = {
  triage: "Triage",
  backlog: "Backlog",
  needs_clarification: "Needs Clarification",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
};

export const STATUS_NAME_MAX_LENGTH = 30;

// 既定名から変えたステータスだけを持つ
export type StatusNames = Partial<Record<Status, string>>;

export interface WorkspaceStatusNames {
  workspaceKey: string;
  names: StatusNames;
}

export function statusDisplayName(status: Status, names: StatusNames | undefined): string {
  return names?.[status] ?? DEFAULT_STATUS_LABELS[status];
}

function requireWorkspace(db: Database, keyOrPath: string): Workspace {
  const workspace = findWorkspace(db, keyOrPath);
  if (!workspace) throw new NodError("NOT_FOUND", `Workspace ${keyOrPath} は登録されていません`);
  return workspace;
}

function readNames(db: Database, workspaceId: number): StatusNames {
  const rows = db.query("SELECT status, name FROM workspace_status_names WHERE workspace_id = ?").all(workspaceId) as {
    status: Status;
    name: string;
  }[];
  const names: StatusNames = {};
  for (const status of STATUSES) {
    const row = rows.find((r) => r.status === status);
    if (row) names[status] = row.name;
  }
  return names;
}

export function getStatusNames(db: Database, keyOrPath: string): WorkspaceStatusNames {
  const workspace = requireWorkspace(db, keyOrPath);
  return { workspaceKey: workspace.key, names: readNames(db, workspace.id) };
}

export function listAllStatusNames(db: Database): Record<string, StatusNames> {
  const workspaces = db.query("SELECT id, key FROM workspaces ORDER BY key").all() as { id: number; key: string }[];
  return Object.fromEntries(workspaces.map((w) => [w.key, readNames(db, w.id)]));
}

// 表示名だけを全体で置き換える。空の値と既定名と同じ値は既定に戻す。内部の状態値・遷移は変えない
export function setStatusNames(ctx: OpCtx, keyOrPath: string, input: Record<string, string | null | undefined>): WorkspaceStatusNames {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM はステータスの表示名を変更できません。変更は me に依頼してください");
  }
  const names: StatusNames = {};
  for (const [status, raw] of Object.entries(input)) {
    if (!(STATUSES as readonly string[]).includes(status)) {
      throw new NodError("INVALID_ARGS", `不明なステータスです: ${status}（${STATUSES.join(", ")} のいずれか）`);
    }
    const name = (raw ?? "").trim();
    if (!name || name === DEFAULT_STATUS_LABELS[status as Status]) continue;
    if (name.length > STATUS_NAME_MAX_LENGTH) {
      throw new NodError("INVALID_ARGS", `ステータスの表示名は ${STATUS_NAME_MAX_LENGTH} 文字までです（${status}）`);
    }
    names[status as Status] = name;
  }
  const shown = STATUSES.map((s) => statusDisplayName(s, names));
  const duplicated = shown.find((name, i) => shown.indexOf(name) !== i);
  if (duplicated !== undefined) {
    throw new NodError("INVALID_ARGS", `表示名「${duplicated}」が複数のステータスで重なっています`);
  }
  return tx(ctx.db, () => {
    const workspace = requireWorkspace(ctx.db, keyOrPath);
    ctx.db.query("DELETE FROM workspace_status_names WHERE workspace_id = ?").run(workspace.id);
    const insert = ctx.db.query("INSERT INTO workspace_status_names (workspace_id, status, name) VALUES (?, ?, ?)");
    for (const [status, name] of Object.entries(names)) insert.run(workspace.id, status, name);
    return { workspaceKey: workspace.key, names: readNames(ctx.db, workspace.id) };
  });
}
