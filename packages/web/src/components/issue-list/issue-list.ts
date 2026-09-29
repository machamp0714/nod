import type { Issue, Status } from "../../api/types";
import { BOARD_STATUSES, priorityMeta, STATUS_META, STATUS_ORDER } from "../../lib/meta";
import type { IssueGroupBy, IssueGroupKey, IssueLayout, IssueTab, IssueSort, SortDirection } from "../../routes/search";
import type { IssueListRow } from "./types";

function priorityRank(priority: number): number {
  return priority === 0 ? 5 : priority;
}

export function sortRows(rows: readonly IssueListRow[], sort: IssueSort = "default", direction: SortDirection = "asc"): IssueListRow[] {
  return [...rows].sort((a, b) => {
    let order: number;
    if (sort === "estimate" || sort === "dueDate") {
      // 未設定は方向にかかわらず末尾に置く
      const x = a.issue[sort], y = b.issue[sort];
      if ((x === null) !== (y === null)) return x === null ? 1 : -1;
    }
    if (sort === "default") {
      order = STATUS_ORDER.indexOf(a.issue.status) - STATUS_ORDER.indexOf(b.issue.status) ||
        priorityRank(a.issue.priority) - priorityRank(b.issue.priority);
    } else if (sort === "priority") {
      order = priorityRank(a.issue.priority) - priorityRank(b.issue.priority);
    } else if (sort === "estimate") {
      order = (a.issue.estimate ?? 0) - (b.issue.estimate ?? 0);
    } else if (sort === "dueDate") {
      order = (a.issue.dueDate ?? "").localeCompare(b.issue.dueDate ?? "");
    } else if (sort === "title") {
      order = a.issue.title.localeCompare(b.issue.title, "ja", { numeric: true });
    } else {
      order = (Date.parse(a.issue[sort]) || 0) - (Date.parse(b.issue[sort]) || 0);
    }
    return order * (direction === "desc" ? -1 : 1) ||
      a.issue.id.localeCompare(b.issue.id, "en", { numeric: true });
  });
}

// 委任中：担当が LLM（me 以外）で、done と canceled 以外（core の delegated と同じ条件）。agent_state は問わない
export function isDelegated(issue: Pick<Issue, "assignee" | "status">): boolean {
  return issue.assignee != null && issue.assignee !== "me" && issue.status !== "done" && issue.status !== "canceled";
}

export function filterRows(rows: readonly IssueListRow[], filter: { tab: IssueTab; q: string; showCompleted?: boolean; showChildren?: boolean }): IssueListRow[] {
  const needle = filter.q.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.showCompleted === false && row.issue.status === "done") return false;
    if (filter.showChildren === false && row.issue.parentId != null) return false;
    if (filter.tab === "ready" && !row.ready) return false;
    if (filter.tab === "needs_clarification" && row.issue.status !== "needs_clarification") return false;
    if (filter.tab === "delegated" && !isDelegated(row.issue)) return false;
    if (needle === "") return true;
    return [row.issue.id, row.issue.title, row.issue.description ?? ""]
      .some((text) => text.toLowerCase().includes(needle));
  });
}

export function countRows(rows: readonly IssueListRow[]): { all: number; ready: number; needsClarification: number; delegated: number } {
  return {
    all: rows.length,
    ready: rows.filter((r) => r.ready).length,
    needsClarification: rows.filter((r) => r.issue.status === "needs_clarification").length,
    delegated: rows.filter((r) => isDelegated(r.issue)).length,
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
  return groupRows(rows, "workspace").map((group) => ({ key: group.key, name: group.workspaceName ?? group.key, rows: group.rows }));
}

export interface RowGroup {
  key: string; // 値なしのグループは空文字
  label: string;
  rows: IssueListRow[];
  workspaceName?: string; // Workspace のグループだけ
  subgroups?: RowGroup[];
}

// 1行が属するグループ（キー、見出し、並び順）。ラベルは複数のグループに属する
function groupEntries(row: IssueListRow, by: IssueGroupKey, nameOfStatus: (status: Status) => string): { key: string; label: string; rank: number | string }[] {
  const { issue } = row;
  switch (by) {
    case "workspace":
      return [{ key: issue.workspace, label: issue.workspace, rank: issue.workspace }];
    case "status":
      return [{ key: issue.status, label: nameOfStatus(issue.status), rank: STATUS_ORDER.indexOf(issue.status) }];
    case "priority":
      return [{ key: String(issue.priority), label: priorityMeta(issue.priority).label, rank: priorityRank(issue.priority) }];
    case "project":
      return [issue.project ? { key: String(issue.project.id), label: issue.project.name, rank: issue.project.name } : { key: "", label: "Projectなし", rank: "" }];
    case "assignee":
      return [issue.assignee ? { key: issue.assignee, label: issue.assignee, rank: issue.assignee } : { key: "", label: "未割り当て", rank: "" }];
    case "label":
      return issue.labels.length ? issue.labels.map((label) => ({ key: label, label, rank: label })) : [{ key: "", label: "ラベルなし", rank: "" }];
  }
}

// 表示中の行をプロパティで分ける。行があるグループだけを返し、グループ内は入力の並び順を保つ。
// 値なしのグループ（Projectなし、未割り当て、ラベルなし）は最後に置く。
// nameOfStatus は Status の見出しに Workspace の表示名を使うときに渡す
export function groupRows(
  rows: readonly IssueListRow[],
  by: IssueGroupKey,
  subBy?: IssueGroupKey,
  nameOfStatus: (status: Status) => string = (status) => STATUS_META[status].label,
): RowGroup[] {
  const groups = new Map<string, RowGroup & { rank: number | string }>();
  for (const row of rows) {
    for (const entry of groupEntries(row, by, nameOfStatus)) {
      let group = groups.get(entry.key);
      if (!group) {
        group = { key: entry.key, label: entry.label, rank: entry.rank, rows: [] };
        if (by === "workspace") group.workspaceName = row.workspaceName;
        groups.set(entry.key, group);
      }
      group.rows.push(row);
    }
  }
  return [...groups.values()]
    .sort((a, b) => {
      if ((a.key === "") !== (b.key === "")) return a.key === "" ? 1 : -1;
      if (typeof a.rank === "number" && typeof b.rank === "number") return a.rank - b.rank;
      return String(a.rank).localeCompare(String(b.rank), "ja", { numeric: true }) || a.key.localeCompare(b.key);
    })
    .map(({ rank: _rank, ...group }) => (subBy && subBy !== by ? { ...group, subgroups: groupRows(group.rows, subBy, undefined, nameOfStatus) } : group));
}

// 画面に適用するグループ化。Board は列が Status なので Status のグループ化を無効にし、サブグループはリストだけで使う
export function effectiveGrouping(
  search: { groupBy?: IssueGroupBy; subGroupBy?: IssueGroupKey },
  layout: IssueLayout,
): { groupBy?: IssueGroupKey; subGroupBy?: IssueGroupKey } {
  const groupBy = search.groupBy;
  if (!groupBy || groupBy === "none" || (layout === "board" && groupBy === "status")) return {};
  if (layout === "board" || !search.subGroupBy || search.subGroupBy === groupBy) return { groupBy };
  return { groupBy, subGroupBy: search.subGroupBy };
}
