import type { Status } from "../api/types";
import { STATUS_ORDER } from "../lib/meta";

export type IssueTab = "all" | "ready" | "needs_clarification";
export type IssueGroupBy = "none" | "workspace";
export type IssueLayout = "list" | "board";
export type ProjectTab = "active" | "completed" | "all";

export interface SelectedSearch {
  selected?: string;
}

export interface ProjectsSearch {
  tab?: ProjectTab;
}

const ISSUE_TABS: readonly IssueTab[] = ["all", "ready", "needs_clarification"];
const ISSUE_LAYOUTS: readonly IssueLayout[] = ["list", "board"];
const PROJECT_TABS: readonly ProjectTab[] = ["active", "completed", "all"];

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}



// Issue 一覧の表示（tab、layout、q）と絞り込み条件（workspace、status、project、label）。
// 絞り込み条件のキーは、GET /api/issues のクエリパラメータと View の filter（core の IssueQuery）と同じ名前にする。
// project は Project の数字の ID（ルートと URL に Project の名前を入れないため）。
export interface IssueListSearch {
  groupBy?: IssueGroupBy;
  blocked?: boolean;
  tab?: IssueTab;
  layout?: IssueLayout;
  q?: string;
  workspace?: string[];
  status?: Status[];
  project?: string;
  label?: string[];
}

// TanStack Router は search params を JSON として読むため、配列は配列で、数字だけの値は数値で届く
function stringList(value: unknown): string[] | undefined {
  const list: unknown[] = Array.isArray(value) ? value : [value];
  const items = list
    .map((v) => (typeof v === "number" ? String(v) : v))
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v !== "");
  return items.length ? [...new Set(items)] : undefined;
}

// URL を手で書き換えられても既定の表示に戻れるよう、知らない値は捨てる。
export function parseIssueListSearch(raw: Record<string, unknown>): IssueListSearch {
  const out: IssueListSearch = {};
  if ("groupBy" in raw) out.groupBy = raw.groupBy === "workspace" ? "workspace" : "none";
  if ([true, "true", "1"].includes(raw.blocked as string | boolean)) out.blocked = true;
  if ([false, "false", "0"].includes(raw.blocked as string | boolean)) out.blocked = false;
  if ("tab" in raw) out.tab = pick(raw.tab, ISSUE_TABS) ?? "all";
  if ("layout" in raw) out.layout = pick(raw.layout, ISSUE_LAYOUTS) ?? "list";
  const q = typeof raw.q === "number" ? String(raw.q) : raw.q;
  if (typeof q === "string" && q !== "") out.q = q;
  const workspace = stringList(raw.workspace)?.map((key) => key.toUpperCase());
  if (workspace) out.workspace = [...new Set(workspace)];
  const status = stringList(raw.status)?.filter((s): s is Status => (STATUS_ORDER as readonly string[]).includes(s));
  if (status?.length) out.status = status;
  const project = typeof raw.project === "number" ? String(raw.project) : raw.project;
  if (typeof project === "string" && /^\d+$/.test(project)) out.project = project;
  const label = stringList(raw.label);
  if (label) out.label = label;
  return out;
}

export function cleanIssueListSearch(search: IssueListSearch): IssueListSearch {
  const out: IssueListSearch = {};
  if (search.groupBy === "workspace") out.groupBy = search.groupBy;
  if (search.blocked !== undefined) out.blocked = search.blocked;
  if (search.tab && search.tab !== "all") out.tab = search.tab;
  if (search.layout && search.layout !== "list") out.layout = search.layout;
  if (search.q) out.q = search.q;
  if (search.workspace?.length) out.workspace = search.workspace;
  if (search.status?.length) out.status = search.status;
  if (search.project) out.project = search.project;
  if (search.label?.length) out.label = search.label;
  return out;
}

export function parseSelectedSearch(raw: Record<string, unknown>): SelectedSearch {
  return typeof raw.selected === "string" ? { selected: raw.selected } : {};
}

export function parseProjectsSearch(raw: Record<string, unknown>): ProjectsSearch {
  return "tab" in raw ? { tab: pick(raw.tab, PROJECT_TABS) ?? "active" } : {};
}

export function cleanProjectsSearch(search: ProjectsSearch): ProjectsSearch {
  return search.tab && search.tab !== "active" ? { tab: search.tab } : {};
}
