import type { IssueQuery, Status } from "../api/types";
import { parseIssueListSearch, type IssueListSearch } from "../routes/search";

export type FilterSearch = Pick<IssueListSearch, "workspace" | "status" | "project" | "milestone" | "cycle" | "label" | "blocked" | "archived">;

// URL の search params から絞り込み条件を取り出す（Issues の画面）
export function filterFromSearch(raw: IssueListSearch): IssueQuery {
  // Router は検証結果にない元のキーを残すため、API に渡す直前にも正規化する。
  const search = parseIssueListSearch({ ...raw });
  const query: IssueQuery = {};
  if (search.workspace?.length) query.workspace = search.workspace;
  if (search.status?.length) query.status = search.status;
  if (search.project) query.project = search.project;
  if (search.milestone) query.milestone = search.milestone;
  if (search.cycle) query.cycle = search.cycle;
  if (search.label?.length) query.label = search.label;
  if (search.blocked !== undefined) query.blocked = search.blocked;
  if (search.archived) query.archived = true;
  return query;
}

// 絞り込み条件を search params に写す。条件にないキーは undefined にし、cleanIssueListSearch で URL から消す
export function filterToSearch(filter: IssueQuery): FilterSearch {
  return { blocked: filter.blocked, archived: filter.archived || undefined, workspace: filter.workspace, status: filter.status, project: filter.project, milestone: filter.milestone, cycle: filter.cycle, label: filter.label };
}

// GET /api/issues のクエリ文字列（先頭の ? を含む。条件がなければ空文字）。配列は同じキーを繰り返す
export function issueQueryToParams(query: IssueQuery): string {
  const params = new URLSearchParams();
  for (const key of query.workspace ?? []) params.append("workspace", key);
  for (const status of query.status ?? []) params.append("status", status);
  if (query.project) params.set("project", query.project);
  if (query.milestone) params.set("milestone", query.milestone);
  if (query.cycle) params.set("cycle", query.cycle);
  for (const label of query.label ?? []) params.append("label", label);
  if (query.ready) params.set("ready", "true");
  if (query.delegated) params.set("delegated", "true");
  if (query.q) params.set("q", query.q);
  if (query.blocked !== undefined) params.set("blocked", String(query.blocked));
  if (query.archived) params.set("archived", "true");
  const text = params.toString();
  return text ? `?${text}` : "";
}

function normalize(query: IssueQuery) {
  const sorted = (list: readonly string[] | undefined) => [...(list ?? [])].sort();
  return {
    workspace: sorted(query.workspace),
    status: sorted(query.status),
    project: query.project ?? "",
    milestone: query.milestone ?? "",
    cycle: query.cycle ?? "",
    label: sorted(query.label),
    ready: query.ready === true,
    delegated: query.delegated === true,
    q: query.q ?? "",
    blocked: query.blocked,
    archived: query.archived === true,
  };
}

// 配列の順を問わずに2つの絞り込み条件を比べる（View の保存していない変更の判定）
export function sameFilter(a: IssueQuery, b: IssueQuery): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

export type FilterKey = "workspace" | "status" | "project" | "milestone" | "cycle" | "label" | "ready" | "delegated" | "q" | "blocked" | "archived";

export interface FilterChip {
  key: FilterKey;
  name: string;
  values: string;
}

export interface FilterOption {
  value: string;
  label: string;
}

export interface MilestoneFilterOption extends FilterOption {
  project: string; // Milestone の Project の名前（同じ名前の Milestone を見分ける）
}

// Milestone のない Issue だけにする条件の値（GET /api/issues の milestone=none）
export const NO_MILESTONE = "none";

export interface FilterOptions {
  workspaces: FilterOption[]; // value は Workspace のキー
  projects: FilterOption[]; // value は Project の数字の ID
  milestones: MilestoneFilterOption[]; // value は Milestone の数字の ID
  cycles: FilterOption[]; // value は Cycle の数字の ID
  labels: string[];
}

// nod.pen の 11 Issues の Filters の行（「Workspace is api-server, nod」）に出すチップ
export function describeFilter(
  filter: IssueQuery,
  labelOf: {
    workspace: (key: string) => string;
    project: (ref: string) => string;
    status: (status: Status) => string;
    milestone?: (ref: string) => string;
  },
): FilterChip[] {
  const chips: FilterChip[] = [];
  if (filter.workspace?.length) {
    chips.push({ key: "workspace", name: "Workspace", values: filter.workspace.map(labelOf.workspace).join(", ") });
  }
  if (filter.status?.length) {
    chips.push({ key: "status", name: "Status", values: filter.status.map(labelOf.status).join(", ") });
  }
  if (filter.project) chips.push({ key: "project", name: "Project", values: labelOf.project(filter.project) });
  if (filter.milestone) {
    const values = filter.milestone === NO_MILESTONE ? "Milestone なし" : (labelOf.milestone?.(filter.milestone) ?? filter.milestone);
    chips.push({ key: "milestone", name: "Milestone", values });
  }
  if (filter.label?.length) chips.push({ key: "label", name: "Label", values: filter.label.join(", ") });
  // ready は絞り込みのバーでは足せないが、API で作った View の filter に入りうるため、外せるように出す
  if (filter.ready) chips.push({ key: "ready", name: "Ready", values: "のみ" });
  // 委任中も同じく、API や CLI で作った View の filter に入りうるため、外せるように出す
  if (filter.delegated) chips.push({ key: "delegated", name: "委任中", values: "のみ" });
  if (filter.q) chips.push({ key: "q", name: "検索", values: filter.q });
  if (filter.blocked !== undefined) chips.push({ key: "blocked", name: "ブロック", values: filter.blocked ? "ブロック中" : "ブロックなし" });
  if (filter.archived) chips.push({ key: "archived", name: "アーカイブ", values: "アーカイブ済みのみ" });
  return chips;
}

export function withoutKey(filter: IssueQuery, key: FilterKey): IssueQuery {
  const next = { ...filter };
  delete next[key];
  return next;
}

export function toggleValue<T extends string>(list: readonly T[] | undefined, value: T): T[] | undefined {
  const next = list?.includes(value) ? list.filter((v) => v !== value) : [...(list ?? []), value];
  return next.length ? next : undefined;
}
