import type { Database } from "bun:sqlite";
import { now, type OpCtx } from "./ctx";
import { formatIssueId, type IssueRow } from "./issue-query";
import { NodError } from "./errors";
import type { Comment } from "./types";

export function recordEvent(
  db: Database,
  issueId: number,
  actor: string,
  type: string,
  data: Record<string, unknown> = {},
): void {
  db.query("INSERT INTO events (issue_id, actor, type, data, created_at) VALUES (?, ?, ?, ?, ?)").run(
    issueId,
    actor,
    type,
    JSON.stringify(data),
    now(),
  );
}

export function addComment(ctx: OpCtx, row: IssueRow, body: string, parentId: number | null = null): Comment {
  const ts = now();
  const { lastInsertRowid } = ctx.db
    .query("INSERT INTO comments (issue_id, author, body, created_at, parent_id) VALUES (?, ?, ?, ?, ?)")
    .run(row.id, ctx.actor, body, ts, parentId);
  ctx.db.query("UPDATE issues SET updated_at = ? WHERE id = ?").run(ts, row.id);
  return {
    id: Number(lastInsertRowid),
    issueId: formatIssueId(row.ws_key, row.number),
    author: ctx.actor,
    body,
    createdAt: ts,
    parentId,
    resolvedAt: null,
    resolvedBy: null,
  };
}

// 返信先を同じ Issue のスレッドの親に解決する。返信への返信は、そのスレッドの親へ付け替える
export function threadRootId(ctx: OpCtx, row: IssueRow, replyTo: number): number {
  const parent = ctx.db.query("SELECT id, issue_id, parent_id FROM comments WHERE id = ?").get(replyTo) as
    | { id: number; issue_id: number; parent_id: number | null }
    | null;
  if (!parent) throw new NodError("NOT_FOUND", `コメント ${replyTo} はありません`);
  if (parent.issue_id !== row.id) {
    throw new NodError("INVALID_ARGS", `コメント ${replyTo} は ${formatIssueId(row.ws_key, row.number)} のコメントではありません`);
  }
  return parent.parent_id ?? parent.id;
}
