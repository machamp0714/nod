import type { Database } from "bun:sqlite";
import { now, type OpCtx } from "./ctx";
import { formatIssueId, type IssueRow } from "./issue-query";
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

export function addComment(ctx: OpCtx, row: IssueRow, body: string): Comment {
  const ts = now();
  const { lastInsertRowid } = ctx.db
    .query("INSERT INTO comments (issue_id, author, body, created_at) VALUES (?, ?, ?, ?)")
    .run(row.id, ctx.actor, body, ts);
  ctx.db.query("UPDATE issues SET updated_at = ? WHERE id = ?").run(ts, row.id);
  return { id: Number(lastInsertRowid), issueId: formatIssueId(row.ws_key, row.number), author: ctx.actor, body, createdAt: ts };
}
