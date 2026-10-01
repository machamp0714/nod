import { NodError } from "./errors";
import { STATUSES, type Issue } from "./types";

// nod issue list --sort の並び順（#174）。id は Workspace と番号の順、default は Web の既定と同じ 状態 → 優先度 → ID
export const ISSUE_SORT_KEYS = ["id", "default", "priority", "created", "updated", "title", "estimate", "due"] as const;
export type IssueSortKey = (typeof ISSUE_SORT_KEYS)[number];
export type IssueSortDirection = "asc" | "desc";

export function parseIssueSortKey(value: string): IssueSortKey {
  const key = value.trim().toLowerCase();
  if (!(ISSUE_SORT_KEYS as readonly string[]).includes(key)) {
    throw new NodError("INVALID_ARGS", `並び順「${value}」は使えません（使えるもの: ${ISSUE_SORT_KEYS.join(", ")}）`);
  }
  return key as IssueSortKey;
}

// 優先度なし（0）は Low の後に置く
function priorityRank(priority: number): number {
  return priority === 0 ? 5 : priority;
}

function compareId(a: Issue, b: Issue): number {
  return a.workspace.localeCompare(b.workspace, "en") || a.number - b.number;
}

// 同順位は向きによらず ID の昇順。見積もり・期限が未設定の Issue はどちらの向きでも末尾に置く（Web の一覧と同じ）
export function sortIssues(issues: readonly Issue[], sort: IssueSortKey = "id", direction: IssueSortDirection = "asc"): Issue[] {
  const sign = direction === "desc" ? -1 : 1;
  return [...issues].sort((a, b) => {
    let order: number;
    if (sort === "estimate" || sort === "due") {
      const x = sort === "estimate" ? a.estimate : a.dueDate;
      const y = sort === "estimate" ? b.estimate : b.dueDate;
      if ((x === null) !== (y === null)) return x === null ? 1 : -1;
    }
    switch (sort) {
      case "id":
        return compareId(a, b) * sign;
      case "default":
        order = STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || priorityRank(a.priority) - priorityRank(b.priority);
        break;
      case "priority":
        order = priorityRank(a.priority) - priorityRank(b.priority);
        break;
      case "estimate":
        order = (a.estimate ?? 0) - (b.estimate ?? 0);
        break;
      case "due":
        order = (a.dueDate ?? "").localeCompare(b.dueDate ?? "");
        break;
      case "title":
        order = a.title.localeCompare(b.title, "ja", { numeric: true });
        break;
      case "created":
        order = (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0);
        break;
      case "updated":
        order = (Date.parse(a.updatedAt) || 0) - (Date.parse(b.updatedAt) || 0);
        break;
    }
    return order * sign || compareId(a, b);
  });
}
