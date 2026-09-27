export type IssueTab = "all" | "ready" | "needs_clarification";
export type IssueLayout = "list" | "board";
export type ProjectTab = "active" | "completed" | "all";

export interface IssueListSearch {
  tab?: IssueTab;
  layout?: IssueLayout;
  q?: string;
}

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

// URL を手で書き換えられても既定の表示に戻れるよう、知らない値は捨てる。
export function parseIssueListSearch(raw: Record<string, unknown>): IssueListSearch {
  const out: IssueListSearch = {};
  const tab = pick(raw.tab, ISSUE_TABS);
  if (tab) out.tab = tab;
  const layout = pick(raw.layout, ISSUE_LAYOUTS);
  if (layout) out.layout = layout;
  // TanStack Router は search params を JSON として読むため、数字だけの検索語は数値で届く。
  const q = typeof raw.q === "number" ? String(raw.q) : raw.q;
  if (typeof q === "string" && q !== "") out.q = q;
  return out;
}

export function cleanIssueListSearch(search: IssueListSearch): IssueListSearch {
  const out: IssueListSearch = {};
  if (search.tab && search.tab !== "all") out.tab = search.tab;
  if (search.layout && search.layout !== "list") out.layout = search.layout;
  if (search.q) out.q = search.q;
  return out;
}

export function parseSelectedSearch(raw: Record<string, unknown>): SelectedSearch {
  return typeof raw.selected === "string" ? { selected: raw.selected } : {};
}

export function parseProjectsSearch(raw: Record<string, unknown>): ProjectsSearch {
  const tab = pick(raw.tab, PROJECT_TABS);
  return tab ? { tab } : {};
}

export function cleanProjectsSearch(search: ProjectsSearch): ProjectsSearch {
  return search.tab && search.tab !== "active" ? { tab: search.tab } : {};
}
