import type { IssueQuery } from "../api/types";
import { parseIssueListSearch, type IssueListSearch } from "../routes/search";

export type FilterSearch = Pick<IssueListSearch, "workspace" | "status" | "project" | "label">;

// URL の search params から絞り込み条件を取り出す（Issues の画面）
export function filterFromSearch(raw: IssueListSearch): IssueQuery {
  // Router は検証結果にない元のキーを残すため、API に渡す直前にも正規化する。
  const search = parseIssueListSearch({ ...raw });
  const query: IssueQuery = {};
  if (search.workspace?.length) query.workspace = search.workspace;
  if (search.status?.length) query.status = search.status;
  if (search.project) query.project = search.project;
  if (search.label?.length) query.label = search.label;
  return query;
}

// 絞り込み条件を search params に写す。条件にないキーは undefined にし、cleanIssueListSearch で URL から消す
export function filterToSearch(filter: IssueQuery): FilterSearch {
  return { workspace: filter.workspace, status: filter.status, project: filter.project, label: filter.label };
}

// GET /api/issues のクエリ文字列（先頭の ? を含む。条件がなければ空文字）。配列は同じキーを繰り返す
export function issueQueryToParams(query: IssueQuery): string {
  const params = new URLSearchParams();
  for (const key of query.workspace ?? []) params.append("workspace", key);
  for (const status of query.status ?? []) params.append("status", status);
  if (query.project) params.set("project", query.project);
  for (const label of query.label ?? []) params.append("label", label);
  if (query.ready) params.set("ready", "true");
  const text = params.toString();
  return text ? `?${text}` : "";
}

function normalize(query: IssueQuery) {
  const sorted = (list: readonly string[] | undefined) => [...(list ?? [])].sort();
  return {
    workspace: sorted(query.workspace),
    status: sorted(query.status),
    project: query.project ?? "",
    label: sorted(query.label),
    ready: query.ready === true,
  };
}

// 配列の順を問わずに2つの絞り込み条件を比べる（View の保存していない変更の判定）
export function sameFilter(a: IssueQuery, b: IssueQuery): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
