import { NodError } from "./errors";

// View に保存する Issue 一覧の表示設定（#175）。キーと値は Web の Issue 一覧の URL のクエリ（packages/web/src/routes/search.ts）と同じ。
// 既定と同じ値は持たない（省いたキーは画面の既定で表示する）。
// 委任中タブは filter の delegated で持つため、tab は取得した行を画面で絞るタブだけを持つ
export const VIEW_TABS = ["ready", "needs_clarification"] as const;
export const VIEW_GROUP_KEYS = ["workspace", "status", "priority", "project", "cycle", "assignee", "label"] as const;
export const VIEW_SORTS = ["priority", "createdAt", "updatedAt", "title", "estimate", "dueDate"] as const;
export const VIEW_COLUMNS = ["priority", "status", "questions", "workspace", "project", "assignee", "pr", "estimate", "dueDate"] as const;

export type ViewGroupKey = (typeof VIEW_GROUP_KEYS)[number];

export interface ViewDisplay {
  tab?: (typeof VIEW_TABS)[number];
  layout?: "board"; // 省くとリスト
  groupBy?: ViewGroupKey;
  subGroupBy?: ViewGroupKey; // groupBy があり、別のプロパティのときだけ
  sort?: (typeof VIEW_SORTS)[number]; // 省くと既定（Status→優先度→ID）
  direction?: "desc"; // 省くと昇順
  columns?: (typeof VIEW_COLUMNS)[number][]; // 省くと画面の既定の列。空の配列は ID・タイトル・更新日時だけ
  showCompleted?: false; // 省くと完了済みを表示
  showChildren?: false; // 省くと子 Issue を表示
}

const DISPLAY_KEYS = ["tab", "layout", "groupBy", "subGroupBy", "sort", "direction", "columns", "showCompleted", "showChildren"];

function invalid(message: string): NodError {
  return new NodError("INVALID_ARGS", message);
}

// allowed のどれか。fallback（既定の値）は受け付けるが undefined を返す
function oneOf<T extends string>(value: unknown, key: string, allowed: readonly T[], fallback?: string): T | undefined {
  if (value === undefined || (fallback !== undefined && value === fallback)) return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw invalid(`display の ${key}「${String(value)}」は使えません（使えるもの: ${[...(fallback === undefined ? [] : [fallback]), ...allowed].join(", ")}）`);
}

function shown(value: unknown, key: string): false | undefined {
  if (value === undefined || value === true) return undefined;
  if (value === false) return false;
  throw invalid(`display の ${key} は true か false で指定してください`);
}

export function validateViewDisplay(value: unknown): ViewDisplay {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid('表示設定はオブジェクトで指定してください（例: {"groupBy": "project", "sort": "priority"}）');
  }
  const raw = value as Record<string, unknown>;
  const unknownKeys = Object.keys(raw).filter((k) => !DISPLAY_KEYS.includes(k));
  if (unknownKeys.length) {
    throw invalid(`表示設定に ${unknownKeys.join(", ")} は使えません（使えるもの: ${DISPLAY_KEYS.join(", ")}）`);
  }
  const d: ViewDisplay = {};
  const tab = oneOf(raw.tab, "tab", VIEW_TABS, "all");
  if (tab) d.tab = tab;
  if (oneOf(raw.layout, "layout", ["board"] as const, "list")) d.layout = "board";
  const groupBy = oneOf(raw.groupBy, "groupBy", VIEW_GROUP_KEYS, "none");
  if (groupBy) d.groupBy = groupBy;
  const subGroupBy = oneOf(raw.subGroupBy, "subGroupBy", VIEW_GROUP_KEYS);
  if (groupBy && subGroupBy && subGroupBy !== groupBy) d.subGroupBy = subGroupBy;
  const sort = oneOf(raw.sort, "sort", VIEW_SORTS, "default");
  if (sort) d.sort = sort;
  if (oneOf(raw.direction, "direction", ["desc"] as const, "asc")) d.direction = "desc";
  if (raw.columns !== undefined) {
    const list: unknown = raw.columns;
    if (!Array.isArray(list) || list.some((c) => !(VIEW_COLUMNS as readonly unknown[]).includes(c))) {
      throw invalid(`display の columns は列の名前の配列で指定してください（使えるもの: ${VIEW_COLUMNS.join(", ")}）`);
    }
    d.columns = VIEW_COLUMNS.filter((c) => list.includes(c));
  }
  if (shown(raw.showCompleted, "showCompleted") === false) d.showCompleted = false;
  if (shown(raw.showChildren, "showChildren") === false) d.showChildren = false;
  return d;
}
