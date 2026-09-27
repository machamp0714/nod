import type { Status } from "../../api/types";
import { BOARD_STATUSES, STATUS_ORDER } from "../../lib/meta";
import type { IssueTab } from "../../routes/search";
import type { IssueListRow } from "./types";

function priorityRank(priority: number): number {
  return priority === 0 ? 5 : priority;
}

export function sortRows(rows: readonly IssueListRow[]): IssueListRow[] {
  return [...rows].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.issue.status) - STATUS_ORDER.indexOf(b.issue.status) ||
      priorityRank(a.issue.priority) - priorityRank(b.issue.priority) ||
      a.issue.id.localeCompare(b.issue.id, undefined, { numeric: true }),
  );
}

export function filterRows(rows: readonly IssueListRow[], filter: { tab: IssueTab; q: string }): IssueListRow[] {
  const needle = filter.q.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.tab === "ready" && !row.ready) return false;
    if (filter.tab === "needs_clarification" && row.issue.status !== "needs_clarification") return false;
    if (needle === "") return true;
    return row.issue.title.toLowerCase().includes(needle) || row.issue.id.toLowerCase().includes(needle);
  });
}

export function countRows(rows: readonly IssueListRow[]): { all: number; ready: number; needsClarification: number } {
  return {
    all: rows.length,
    ready: rows.filter((r) => r.ready).length,
    needsClarification: rows.filter((r) => r.issue.status === "needs_clarification").length,
  };
}

export interface BoardColumn {
  status: Status;
  rows: IssueListRow[];
}

export function groupForBoard(rows: readonly IssueListRow[]): BoardColumn[] {
  return BOARD_STATUSES.map((status) => ({ status, rows: rows.filter((r) => r.issue.status === status) }));
}
