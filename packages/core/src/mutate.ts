import { now, type OpCtx } from "./ctx";
import { recordEvent } from "./events";
import type { IssueRow } from "./issue-query";

export type Column =
  | "status"
  | "priority"
  | "estimate"
  | "due_date"
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
  estimate: "estimate_changed",
  due_date: "due_date_changed",
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
  extra: { from?: unknown; to?: unknown; reason?: string; trigger?: "answer"; report_comment_id?: number; automation?: string } = {},
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
    // 人が実行した自動化ルールによる変更は、どのルールかを残す
    if (extra.automation) data.automation = extra.automation;
    if (type === "status_changed" && to === "in_review" && extra.report_comment_id !== undefined) {
      data.report_comment_id = extra.report_comment_id;
    }
    // 書き手と作業主体は別。過去の履歴を現在の担当者で解釈し直さないよう記録する。
    if (type === "agent_state_changed") {
      data.agent = row.assignee;
      if (extra.trigger) data.trigger = extra.trigger;
    }
    recordEvent(ctx.db, row.id, ctx.actor, type, data);
  }
  return true;
}
