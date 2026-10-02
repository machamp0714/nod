import type { DocKind, Status } from "../api/types";
import { STATUS_ORDER } from "../lib/meta";

export type IssueTab = "all" | "ready" | "needs_clarification" | "delegated";
export const ISSUE_GROUP_KEYS = ["workspace", "status", "priority", "project", "cycle", "assignee", "label"] as const;
export type IssueGroupKey = typeof ISSUE_GROUP_KEYS[number];
export type IssueGroupBy = "none" | IssueGroupKey;
export type IssueLayout = "list" | "board";
export type IssueSort = "default" | "priority" | "createdAt" | "updatedAt" | "title" | "estimate" | "dueDate";
const ISSUE_SORTS: readonly IssueSort[] = ["default", "priority", "createdAt", "updatedAt", "title", "estimate", "dueDate"];
export type SortDirection = "asc" | "desc";
// 表示設定のチップの順（design/nod.pen「Display Popover｜表示列（行見本に合わせる）」U6jFNg）
export const ISSUE_COLUMNS = ["priority", "status", "questions", "workspace", "project", "assignee", "pr", "estimate", "dueDate"] as const;
export type IssueColumn = typeof ISSUE_COLUMNS[number];
// 既定の列は design/nod.pen「11 Issues」（O7KCp3）の行に合わせる（#196）。未決事項・PR・見積もり・期限は表示設定のチップで出す。
// 列を明示した既存の URL（columns=...）と View（display.columns）はそのまま復元する。
// ID・タイトル・ラベル・更新日時は列のキーを持たず、常に出す
export const DEFAULT_ISSUE_COLUMNS: readonly IssueColumn[] = ["priority", "status", "workspace", "project", "assignee"];

// 画面の既定の列。全行が同じ値になる列（Project 詳細の Project）は既定から外す。
// 外した列も表示設定のチップで出せ、そのときは列を URL に明示する（columns=...）
export function defaultIssueColumns(sameValueColumn?: IssueColumn): IssueColumn[] {
  return DEFAULT_ISSUE_COLUMNS.filter((column) => column !== sameValueColumn);
}

export type ProjectTab = "active" | "completed" | "all";

export interface SelectedSearch {
  selected?: string;
}

export interface ProjectsSearch {
  tab?: ProjectTab;
}

const ISSUE_TABS: readonly IssueTab[] = ["all", "ready", "needs_clarification", "delegated"];
const ISSUE_LAYOUTS: readonly IssueLayout[] = ["list", "board"];
const PROJECT_TABS: readonly ProjectTab[] = ["active", "completed", "all"];

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}



// Issue 一覧の表示（tab、layout、q）と絞り込み条件（workspace、status、project、label）。
// 絞り込み条件のキーは、GET /api/issues のクエリパラメータと View の filter（core の IssueQuery）と同じ名前にする。
// project は Project の数字の ID（ルートと URL に Project の名前を入れないため）。
export interface IssueListSearch {
  showCompleted?: boolean;
  showChildren?: boolean;
  sort?: IssueSort;
  direction?: SortDirection;
  columns?: IssueColumn[];
  groupBy?: IssueGroupBy;
  subGroupBy?: IssueGroupKey;
  preview?: string; // 一覧の上で中身を確かめる Issue の ID
  blocked?: boolean;
  archived?: boolean; // true ならアーカイブ済みだけ（省くとアーカイブ済みを除く）
  tab?: IssueTab;
  layout?: IssueLayout;
  q?: string;
  workspace?: string[];
  status?: Status[];
  project?: string;
  milestone?: string; // Milestone の数字の ID か "none"（Milestone のない Issue）
  cycle?: string; // Cycle の数字の ID か "none"（Cycle のない Issue）
  label?: string[];
  assignee?: string[]; // 担当の名前。"none" は未割り当て
}

// 担当の絞り込みで未割り当てを指す値（GET /api/issues の assignee=none）
export const NO_ASSIGNEE = "none";

// TanStack Router は search params を JSON として読むため、配列は配列で、数字だけの値は数値で届く
// splitComma は値をカンマでも分ける（assignee で使う。label は core と同じく分けない）
function stringList(value: unknown, splitComma = false): string[] | undefined {
  const list: unknown[] = Array.isArray(value) ? value : [value];
  const items = list
    .map((v) => (typeof v === "number" ? String(v) : v))
    .filter((v): v is string => typeof v === "string")
    .flatMap((v) => (splitComma ? v.split(",") : [v]))
    .map((v) => v.trim())
    .filter((v) => v !== "");
  return items.length ? [...new Set(items)] : undefined;
}

// URL を手で書き換えられても既定の表示に戻れるよう、知らない値は捨てる。
export function parseIssueListSearch(raw: Record<string, unknown>): IssueListSearch {
  const out: IssueListSearch = {};
  for (const key of ["showCompleted", "showChildren"] as const) {
    if (key in raw) out[key] = raw[key] !== false && raw[key] !== "false";
  }
  if ("sort" in raw) out.sort = pick(raw.sort, ISSUE_SORTS) ?? "default";
  if ("direction" in raw) out.direction = pick(raw.direction, ["asc", "desc"] as const) ?? "asc";
  if ("columns" in raw) out.columns = [...DEFAULT_ISSUE_COLUMNS];
  if (Array.isArray(raw.columns) && raw.columns.every((value) => pick(value, ISSUE_COLUMNS))) {
    out.columns = ISSUE_COLUMNS.filter((column) => (raw.columns as unknown[]).includes(column));
  }
  if ("groupBy" in raw) out.groupBy = pick(raw.groupBy, ISSUE_GROUP_KEYS) ?? "none";
  const subGroupBy = pick(raw.subGroupBy, ISSUE_GROUP_KEYS);
  if (subGroupBy) out.subGroupBy = subGroupBy;
  if (typeof raw.preview === "string" && /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(raw.preview)) out.preview = raw.preview.toUpperCase();
  if ([true, "true", "1"].includes(raw.blocked as string | boolean)) out.blocked = true;
  if ([false, "false", "0"].includes(raw.blocked as string | boolean)) out.blocked = false;
  if ([true, "true", "1"].includes(raw.archived as string | boolean)) out.archived = true;
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
  const milestone = typeof raw.milestone === "number" ? String(raw.milestone) : raw.milestone;
  if (typeof milestone === "string" && /^([1-9]\d*|none)$/.test(milestone)) out.milestone = milestone;
  const cycle = typeof raw.cycle === "number" ? String(raw.cycle) : raw.cycle;
  if (typeof cycle === "string" && /^(\d+|none)$/.test(cycle)) out.cycle = cycle;
  const label = stringList(raw.label);
  if (label) out.label = label;
  // API は assignee をカンマでも分けるため、手で書いた assignee=me,codex もチップとパネルが API の結果と合うように分ける
  const assignee = stringList(raw.assignee, true)?.map((name) => (name.toLowerCase() === NO_ASSIGNEE ? NO_ASSIGNEE : name));
  if (assignee) out.assignee = [...new Set(assignee)];
  return out;
}

// タブの既定のグループ化。委任中タブは LLM ごとに見られるよう、グループ化が未指定なら担当でまとめる。
// URL には書かないため、タブを離れると元の表示に戻る。委任中タブで明示した「なし」は groupBy=none として URL に残す。
// My issues（mine）はタブを持たず、Status でまとめる（Pencil「My issues｜担当タブ（#162）」）
export function defaultGroupBy(tab: IssueTab | undefined, mine = false): IssueGroupKey | undefined {
  if (mine) return "status";
  return tab === "delegated" ? "assignee" : undefined;
}

function sameColumns(a: readonly IssueColumn[], b: readonly IssueColumn[]): boolean {
  return a.length === b.length && b.every((column) => a.includes(column));
}

// mine は My issues の URL。タブを持たず（担当が me と LLM の Issue をまとめて出す）、担当の条件は固定のため URL に持たない。
// sameValueColumn はその画面で既定から外す列（defaultIssueColumns）。列がその画面の既定と同じなら URL に書かない
export function cleanIssueListSearch(search: IssueListSearch, mine = false, sameValueColumn?: IssueColumn): IssueListSearch {
  if (mine) search = { ...search, tab: undefined, assignee: undefined };
  const out: IssueListSearch = {};
  if (search.showCompleted === false) out.showCompleted = false;
  if (search.showChildren === false) out.showChildren = false;
  if (search.sort && search.sort !== "default") out.sort = search.sort;
  if (search.direction === "desc") out.direction = search.direction;
  if (search.columns && !sameColumns(search.columns, defaultIssueColumns(sameValueColumn))) out.columns = search.columns;
  const fallback = defaultGroupBy(search.tab, mine);
  if (search.groupBy && search.groupBy !== "none") out.groupBy = search.groupBy;
  else if (search.groupBy === "none" && fallback) out.groupBy = "none";
  const groupBy = search.groupBy ?? fallback;
  // サブグループはグループ化があり、グループと別のプロパティのときだけ意味を持つ
  if (groupBy && groupBy !== "none" && search.subGroupBy && search.subGroupBy !== groupBy) out.subGroupBy = search.subGroupBy;
  if (search.preview) out.preview = search.preview;
  if (search.blocked !== undefined) out.blocked = search.blocked;
  if (search.archived) out.archived = true;
  if (search.tab && search.tab !== "all") out.tab = search.tab;
  if (search.layout && search.layout !== "list") out.layout = search.layout;
  if (search.q) out.q = search.q;
  if (search.workspace?.length) out.workspace = search.workspace;
  if (search.status?.length) out.status = search.status;
  if (search.project) out.project = search.project;
  if (search.milestone) out.milestone = search.milestone;
  if (search.cycle) out.cycle = search.cycle;
  if (search.label?.length) out.label = search.label;
  if (search.assignee?.length) out.assignee = search.assignee;
  return out;
}

export function cleanMyIssuesSearch(search: IssueListSearch): IssueListSearch {
  return cleanIssueListSearch(search, true);
}

// Project 詳細の URL。全行が同じ Project になるため、Project の列を既定から外す
export function cleanProjectIssuesSearch(search: IssueListSearch): IssueListSearch {
  return cleanIssueListSearch(search, false, "project");
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

// 表示設定の変更は履歴から戻せるようにする。検索入力は従来どおり履歴を置換する。
export function replacesIssueListHistory(patch: IssueListSearch): boolean {
  return !("showCompleted" in patch || "showChildren" in patch || "sort" in patch || "direction" in patch || "columns" in patch);
}

export interface DocumentsSearch {
  kind?: DocKind;
}

const DOC_KIND_VALUES: readonly DocKind[] = ["spec", "plan", "doc"];

// Documents 一覧の種類の絞り込み。知らない値は捨てて全件にする
export function parseDocumentsSearch(search: Record<string, unknown>): DocumentsSearch {
  const kind = pick(search.kind, DOC_KIND_VALUES);
  return kind ? { kind } : {};
}

export interface NewDocumentSearch {
  issue?: string;
}

// Issue 詳細の「新規作成」から来たときのリンク先
export function parseNewDocumentSearch(search: Record<string, unknown>): NewDocumentSearch {
  const issue = typeof search.issue === "string" ? search.issue.trim() : "";
  return issue ? { issue } : {};
}
