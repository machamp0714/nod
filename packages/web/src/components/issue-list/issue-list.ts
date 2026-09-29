import type { Status } from "../../api/types";
import { BOARD_STATUSES, STATUS_ORDER } from "../../lib/meta";
import type { IssueTab, IssueSort, SortDirection } from "../../routes/search";
import type { IssueListRow } from "./types";

function priorityRank(priority: number): number {
  return priority === 0 ? 5 : priority;
}

export function sortRows(rows: readonly IssueListRow[], sort: IssueSort = "default", direction: SortDirection = "asc"): IssueListRow[] {
  return [...rows].sort((a, b) => {
    let order: number;
    if (sort === "default") {
      order = STATUS_ORDER.indexOf(a.issue.status) - STATUS_ORDER.indexOf(b.issue.status) ||
        priorityRank(a.issue.priority) - priorityRank(b.issue.priority);
    } else if (sort === "priority") {
      order = priorityRank(a.issue.priority) - priorityRank(b.issue.priority);
    } else if (sort === "title") {
      order = a.issue.title.localeCompare(b.issue.title, "ja", { numeric: true });
    } else {
      order = (Date.parse(a.issue[sort]) || 0) - (Date.parse(b.issue[sort]) || 0);
    }
    return order * (direction === "desc" ? -1 : 1) ||
      a.issue.id.localeCompare(b.issue.id, "en", { numeric: true });
  });
}

export function filterRows(rows: readonly IssueListRow[], filter: { tab: IssueTab; q: string }): IssueListRow[] {
  const needle = filter.q.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.tab === "ready" && !row.ready) return false;
    if (filter.tab === "needs_clarification" && row.issue.status !== "needs_clarification") return false;
    if (needle === "") return true;
    return [row.issue.id, row.issue.title, row.issue.description ?? ""]
      .some((text) => text.toLowerCase().includes(needle));
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

export function groupRowsByWorkspace(rows: readonly IssueListRow[]): { key: string; name: string; rows: IssueListRow[] }[] {
  const groups = new Map<string, { key: string; name: string; rows: IssueListRow[] }>();
  for (const row of rows) {
    const key = row.issue.workspace;
    let group = groups.get(key);
    if (!group) {
      group = { key, name: row.workspaceName, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}
