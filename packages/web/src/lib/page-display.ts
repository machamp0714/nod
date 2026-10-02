import type { PageDisplay } from "../api/types";
import { cleanIssueListSearch, type IssueColumn, type IssueListSearch } from "../routes/search";

// Issue 一覧のページごとに DB へ保存する表示設定（#218）。View（view-display.ts）と違い、ポップオーバーで変えるたびに自動で保存する。
// タブ・絞り込み・検索・プレビューは保存しない
export type PageKey = "issues" | "my-issues" | `project:${string}` | `cycle:${string}`;

// mine と sameValueColumn は、その画面の既定（グループ化・列）を決める。cleanIssueListSearch に渡すものと同じ
export interface PageScope {
  key: PageKey;
  mine?: boolean;
  sameValueColumn?: IssueColumn;
}

export const PAGE_DISPLAY_KEYS = ["layout", "groupBy", "subGroupBy", "sort", "direction", "columns", "showCompleted", "showChildren"] as const;

// ポップオーバーの変更か。サブグループの「なし」は { subGroupBy: undefined } で届くため、値ではなくキーで見る
export function hasDisplayKey(patch: IssueListSearch): boolean {
  return PAGE_DISPLAY_KEYS.some((key) => key in patch);
}

// 画面に表示する状態。URL に明示したキーは URL を優先し、ないキーは保存した表示設定を使う（View の viewSearch と同じ優先順位）
export function pageSearch(display: PageDisplay, url: IssueListSearch): IssueListSearch {
  const out: IssueListSearch = { ...url };
  for (const key of PAGE_DISPLAY_KEYS) {
    const value = url[key] ?? display[key];
    if (value === undefined) delete out[key];
    else (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

// 保存する表示設定。その画面の既定と同じ値は持たない（My Issues の「なし」は既定と違うので groupBy: none で持つ）
export function pageDisplayFromSearch(search: IssueListSearch, scope: PageScope): PageDisplay {
  const s = cleanIssueListSearch(search, scope.mine ?? false, scope.sameValueColumn);
  const d: PageDisplay = {};
  if (s.layout === "board") d.layout = "board";
  if (s.groupBy) d.groupBy = s.groupBy;
  if (s.subGroupBy) d.subGroupBy = s.subGroupBy;
  if (s.sort && s.sort !== "default") d.sort = s.sort;
  if (s.direction === "desc") d.direction = "desc";
  if (s.columns) d.columns = s.columns;
  if (s.showCompleted === false) d.showCompleted = false;
  if (s.showChildren === false) d.showChildren = false;
  return d;
}

// 「既定に戻す」で URL から表示設定のキーだけを消す
export function withoutPageDisplay(search: IssueListSearch): IssueListSearch {
  const out: IssueListSearch = { ...search };
  for (const key of PAGE_DISPLAY_KEYS) delete out[key];
  return out;
}
