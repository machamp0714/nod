import type { Database } from "bun:sqlite";
import type { ReviewIssue } from "./types";

export type ReviewData = Pick<ReviewIssue, "reviewSummary" | "reviewReport" | "reviewSubmittedAt">;

// 一覧全体をまとめて取得する。新記録はIDで対応し、旧記録だけ時刻で復元する。
export function readReviewSummaries(db: Database, refs: readonly string[]): Map<string, ReviewData> {
  const result = new Map<string, ReviewData>();
  for (let offset = 0; offset < refs.length; offset += 400) {
    const batch = refs.slice(offset, offset + 400);
    const rows = db.query(`SELECT w.key || '-' || i.number AS ref, e.created_at AS submitted,
      c.author, c.body, c.created_at AS report_at
      FROM issues i JOIN workspaces w ON w.id = i.workspace_id
      LEFT JOIN events e ON e.id = (SELECT MAX(id) FROM events WHERE issue_id = i.id
        AND type = 'status_changed' AND json_extract(data, '$.to') = 'in_review')
      LEFT JOIN comments c ON c.issue_id = i.id AND c.id = CASE
        WHEN json_type(e.data, '$.report_comment_id') IS NOT NULL THEN
          CASE WHEN json_type(e.data, '$.report_comment_id') = 'integer' THEN json_extract(e.data, '$.report_comment_id') END
        ELSE (SELECT id FROM comments WHERE issue_id = i.id AND created_at <= e.created_at ORDER BY created_at DESC, id DESC LIMIT 1)
      END
      WHERE w.key || '-' || i.number IN (${batch.map(() => "?").join(",")})`).all(...batch) as
      { ref: string; submitted: string | null; author: string | null; body: string | null; report_at: string | null }[];
    for (const row of rows) result.set(row.ref, {
      reviewSummary: row.body,
      reviewReport: row.body !== null && row.author !== null && row.report_at !== null
        ? { actor: row.author, at: row.report_at, body: row.body } : null,
      reviewSubmittedAt: row.submitted,
    });
  }
  return result;
}
