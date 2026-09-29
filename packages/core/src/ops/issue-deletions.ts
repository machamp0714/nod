import type { Database } from "bun:sqlite";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { findIssueRow, formatIssueId, type IssueRow } from "../issue-query";
import { defaultAttachmentsDir, removeStoredFiles } from "./attachments";
import { findWorkspace } from "./workspaces";

export interface IssueDeletion {
  id: number;
  issueId: string; // 削除時の ID（例: API-12）。番号は再利用されない
  title: string;
  archivedAt: string;
  deletedBy: string;
  deletedAt: string;
}

interface IssueDeletionRow {
  id: number;
  issue_id: string;
  title: string;
  archived_at: string;
  deleted_by: string;
  deleted_at: string;
}

function toDeletion(r: IssueDeletionRow): IssueDeletion {
  return {
    id: r.id,
    issueId: r.issue_id,
    title: r.title,
    archivedAt: r.archived_at,
    deletedBy: r.deleted_by,
    deletedAt: r.deleted_at,
  };
}

// 永久削除できるか確かめる。人（LLM 以外）が、アーカイブ済みの Issue に対してだけ行える。CLI の確認前にも呼ぶ
export function findDeletableIssueRow(ctx: OpCtx, ref: string): IssueRow {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は Issue を削除できません。削除は me に依頼してください");
  }
  const row = findIssueRow(ctx.db, ref);
  if (row.archived_at === null) {
    const issueId = formatIssueId(row.ws_key, row.number);
    throw new NodError("INVALID_STATE", `${issueId} はアーカイブされていません。先にアーカイブしてください（nod issue archive ${issueId}）`);
  }
  return row;
}

// アーカイブ済みの Issue を永久に消し、Workspace の監査ログに残す。
// 関連する行は外部キーで消え（子 Issue の親と定期Issueの起票記録は NULL になって残る）、添付の実体は commit 後に消す
export function deleteIssue(ctx: OpCtx, ref: string, attachmentsDir: string = defaultAttachmentsDir()): IssueDeletion {
  const { deletion, files } = tx(ctx.db, () => {
    const row = findDeletableIssueRow(ctx, ref);
    const issueId = formatIssueId(row.ws_key, row.number);
    const files = (
      ctx.db.query("SELECT file_path FROM issue_attachments WHERE issue_id = ? AND file_path IS NOT NULL").all(row.id) as {
        file_path: string;
      }[]
    ).map((r) => r.file_path);
    const inserted = ctx.db
      .query(
        `INSERT INTO issue_deletions (workspace_id, issue_id, number, title, archived_at, deleted_by, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(row.workspace_id, issueId, row.number, row.title, row.archived_at as string, ctx.actor, now()) as IssueDeletionRow;
    ctx.db.query("DELETE FROM issues WHERE id = ?").run(row.id);
    return { deletion: toDeletion(inserted), files };
  });
  removeStoredFiles(files, attachmentsDir);
  return deletion;
}

// Workspace の Issue 削除の監査ログ。新しい順
export function listIssueDeletions(db: Database, keyOrPath: string): IssueDeletion[] {
  const workspace = findWorkspace(db, keyOrPath);
  if (!workspace) throw new NodError("NOT_FOUND", `Workspace ${keyOrPath} は登録されていません`);
  return (
    db.query("SELECT * FROM issue_deletions WHERE workspace_id = ? ORDER BY id DESC").all(workspace.id) as IssueDeletionRow[]
  ).map(toDeletion);
}
