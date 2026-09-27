import type { Database } from "bun:sqlite";
import { HUMAN_ACTOR, type OpCtx } from "./ctx";
import type { IssueRow } from "./issue-query";
import { setColumn } from "./mutate";

// 未回答の確認依頼の件数。llmOnly なら書き手が LLM のものだけを数える
export function openQuestionCount(db: Database, issueId: number, opts: { llmOnly?: boolean } = {}): number {
  const row = opts.llmOnly
    ? db
        .query("SELECT count(*) AS n FROM questions WHERE issue_id = ? AND answer IS NULL AND asked_by <> ?")
        .get(issueId, HUMAN_ACTOR)
    : db.query("SELECT count(*) AS n FROM questions WHERE issue_id = ? AND answer IS NULL").get(issueId);
  return (row as { n: number }).n;
}

// backlog か todo の Issue に未回答の確認依頼があれば、needs_clarification にする
export function enterClarification(ctx: OpCtx, row: IssueRow): void {
  if (row.status !== "backlog" && row.status !== "todo") return;
  if (openQuestionCount(ctx.db, row.id) === 0) return;
  setColumn(ctx, row, "status", "needs_clarification");
}

// needs_clarification の Issue の確認依頼がすべて回答済みなら、needs_clarification に変えたときの from に戻す
export function leaveClarification(ctx: OpCtx, row: IssueRow): void {
  if (row.status !== "needs_clarification") return;
  if (openQuestionCount(ctx.db, row.id) > 0) return;
  const last = ctx.db
    .query(
      `SELECT json_extract(data, '$.from') AS status FROM events
       WHERE issue_id = ? AND type = 'status_changed' AND json_extract(data, '$.to') = 'needs_clarification'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(row.id) as { status: string | null } | null;
  setColumn(ctx, row, "status", last?.status === "backlog" ? "backlog" : "todo");
}
