import { now, type OpCtx } from "./ctx";
import { recordEvent } from "./events";
import type { IssueRow } from "./issue-query";

export type Column =
  | "status"
  | "priority"
  | "assignee"
  | "agent_state"
  | "title"
  | "description"
  | "project_id"
  | "parent_id"
  | "snoozed_until"
  | "pr_url"
  | "close_reason"
  | "branch"
  | "worktree"
  | "plan_source";

const EVENT_OF: Partial<Record<Column, string>> = {
  status: "status_changed",
  priority: "priority_changed",
  assignee: "assignee_changed",
  agent_state: "agent_state_changed",
  title: "title_changed",
  description: "description_changed",
  project_id: "project_changed",
  parent_id: "parent_changed",
};

// 列の値が変わるときだけ更新し、その列に対応する event を書く。row も同じ値に書き換える
export function setColumn(
  ctx: OpCtx,
  row: IssueRow,
  column: Column,
  to: string | number | null,
  extra: { from?: unknown; to?: unknown; reason?: string } = {},
): boolean {
  const from = row[column];
  if (from === to) return false;
  const ts = now();
  ctx.db.query(`UPDATE issues SET ${column} = ?, updated_at = ? WHERE id = ?`).run(to, ts, row.id);
  (row as unknown as Record<string, unknown>)[column] = to;
  row.updated_at = ts;
  if (column === "status") {
    const closedAt = to === "done" || to === "canceled" ? ts : null;
    const startedAt = to === "in_progress" && !row.started_at ? ts : row.started_at;
    ctx.db.query("UPDATE issues SET closed_at = ?, started_at = ? WHERE id = ?").run(closedAt, startedAt, row.id);
    row.closed_at = closedAt;
    row.started_at = startedAt;
  }
  const type = EVENT_OF[column];
  if (type) {
    const data: Record<string, unknown> = {
      from: "from" in extra ? extra.from : from,
      to: "to" in extra ? extra.to : to,
    };
    if (extra.reason) data.reason = extra.reason;
    recordEvent(ctx.db, row.id, ctx.actor, type, data);
  }
  return true;
}
