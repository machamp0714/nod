import type { ViewDisplay } from "../api/types";
import { cleanIssueListSearch, DEFAULT_ISSUE_COLUMNS, defaultGroupBy, ISSUE_COLUMNS, type IssueColumn, type IssueListSearch } from "../routes/search";
import { COLUMN_NAMES, GROUP_NAMES, SORT_OPTIONS } from "./display-names";

// View に保存する一覧の表示設定（#175）。core の ViewDisplay と同じく、既定と違う値だけを持つ。
// 絞り込み条件は View の filter、検索欄の入力（q）とプレビューは保存しない

// URL のクエリから、View に保存する表示設定を取り出す。
// 委任中タブは filter の delegated で保存するため tab には入れず、そのタブの既定のグループ化（担当）を保存する
export function displayFromSearch(search: IssueListSearch): ViewDisplay {
  const s = cleanIssueListSearch(search);
  const d: ViewDisplay = {};
  if (s.tab === "ready" || s.tab === "needs_clarification") d.tab = s.tab;
  if (s.layout === "board") d.layout = "board";
  const groupBy = s.groupBy ?? defaultGroupBy(s.tab);
  if (groupBy && groupBy !== "none") {
    d.groupBy = groupBy;
    if (s.subGroupBy && s.subGroupBy !== groupBy) d.subGroupBy = s.subGroupBy;
  }
  if (s.sort && s.sort !== "default") d.sort = s.sort;
  if (s.direction === "desc") d.direction = "desc";
  if (s.columns) d.columns = s.columns;
  if (s.showCompleted === false) d.showCompleted = false;
  if (s.showChildren === false) d.showChildren = false;
  return d;
}

// View の画面に表示する状態。URL に明示したキーは URL を優先し、ないキーは View の表示設定を使う。
// URL の subGroupBy が表示中の groupBy と同じなら「サブグループなし」を表す（cleanIssueListSearch が無視する）
export function viewSearch(display: ViewDisplay, url: IssueListSearch): IssueListSearch {
  return cleanIssueListSearch({
    ...url,
    tab: url.tab ?? display.tab,
    layout: url.layout ?? display.layout,
    groupBy: url.groupBy ?? display.groupBy,
    subGroupBy: url.subGroupBy ?? display.subGroupBy,
    sort: url.sort ?? display.sort,
    direction: url.direction ?? display.direction,
    columns: url.columns ?? display.columns,
    showCompleted: url.showCompleted ?? display.showCompleted,
    showChildren: url.showChildren ?? display.showChildren,
  });
}

function sameColumns(a: readonly IssueColumn[], b: readonly IssueColumn[]): boolean {
  return a.length === b.length && b.every((column) => a.includes(column));
}

// View の画面の URL。View の表示設定と同じ値は書かず（開き直すと View の表示設定に戻る）、違う値だけを書く。
// View の表示設定を既定に戻したときは、既定の値を明示する（tab=all、groupBy=none、sort=default など）。
// サブグループを外したときは、subGroupBy に表示中の groupBy と同じ値を書く
export function cleanViewSearch(search: IssueListSearch, display: ViewDisplay): IssueListSearch {
  const current = cleanIssueListSearch(search);
  const saved = viewSearch(display, {});
  const out: IssueListSearch = { ...current };
  delete out.tab;
  if ((current.tab ?? "all") !== (saved.tab ?? "all")) out.tab = current.tab ?? "all";
  delete out.layout;
  if ((current.layout ?? "list") !== (saved.layout ?? "list")) out.layout = current.layout ?? "list";
  // グループ化は、タブの既定（委任中は担当）を解決した値で比べる
  const groupBy = current.groupBy ?? defaultGroupBy(current.tab) ?? "none";
  delete out.groupBy;
  if (groupBy !== (display.groupBy ?? defaultGroupBy(current.tab) ?? "none")) out.groupBy = groupBy;
  delete out.subGroupBy;
  if (current.subGroupBy !== saved.subGroupBy) {
    if (current.subGroupBy) out.subGroupBy = current.subGroupBy;
    else if (groupBy !== "none") out.subGroupBy = groupBy;
  }
  delete out.sort;
  if ((current.sort ?? "default") !== (saved.sort ?? "default")) out.sort = current.sort ?? "default";
  delete out.direction;
  if ((current.direction ?? "asc") !== (saved.direction ?? "asc")) out.direction = current.direction ?? "asc";
  delete out.columns;
  if (!sameColumns(current.columns ?? DEFAULT_ISSUE_COLUMNS, saved.columns ?? DEFAULT_ISSUE_COLUMNS)) out.columns = current.columns ?? [...DEFAULT_ISSUE_COLUMNS];
  delete out.showCompleted;
  if ((current.showCompleted !== false) !== (saved.showCompleted !== false)) out.showCompleted = current.showCompleted !== false;
  delete out.showChildren;
  if ((current.showChildren !== false) !== (saved.showChildren !== false)) out.showChildren = current.showChildren !== false;
  return out;
}

// 表示設定のキーを URL から外す（View の表示設定に戻す）。絞り込み・検索・プレビューは残す
export function withoutDisplay(search: IssueListSearch): IssueListSearch {
  const { tab: _tab, layout: _layout, groupBy: _groupBy, subGroupBy: _subGroupBy, sort: _sort, direction: _direction, columns: _columns, showCompleted: _showCompleted, showChildren: _showChildren, ...rest } = search;
  return rest;
}

function normalize(d: ViewDisplay) {
  return [d.tab, d.layout, d.groupBy, d.subGroupBy, d.sort, d.direction, d.columns && ISSUE_COLUMNS.filter((c) => d.columns?.includes(c)), d.showCompleted, d.showChildren].map((v) => v ?? null);
}

// View に保存した表示設定を、画面が保存するときと同じ形にそろえる。
// API は既定と同じ列（順だけ違うものも）も受け付けるため、そのまま比べると開くたびに「変更あり」になる
export function savedDisplay(display: ViewDisplay): ViewDisplay {
  return displayFromSearch(viewSearch(display, {}));
}

// キーの順を問わずに2つの表示設定を比べる（View の保存していない変更の判定）
export function sameDisplay(a: ViewDisplay, b: ViewDisplay): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

export interface DisplayItem {
  name: string;
  value: string;
}

const TAB_NAMES = { ready: "Ready", needs_clarification: "Needs Clarification" } as const;

// 保存ダイアログの「保存する内容」の「表示」に出す表示設定（design/nod.pen「View として保存｜ダイアログ」PdYmE）。既定と違うものだけを並べる
export function describeDisplay(d: ViewDisplay): DisplayItem[] {
  const items: DisplayItem[] = [];
  if (d.tab) items.push({ name: "タブ", value: TAB_NAMES[d.tab] });
  if (d.layout === "board") items.push({ name: "表示", value: "ボード" });
  if (d.groupBy) items.push({ name: "グループ", value: GROUP_NAMES[d.groupBy] });
  if (d.subGroupBy) items.push({ name: "サブグループ", value: GROUP_NAMES[d.subGroupBy] });
  if (d.sort || d.direction) {
    const option = SORT_OPTIONS.find((o) => o.value === (d.sort ?? "default"));
    items.push({ name: "並び", value: `${option?.short ?? option?.label ?? ""}（${d.direction === "desc" ? "降順" : "昇順"}）` });
  }
  if (d.columns) items.push({ name: "列", value: d.columns.length ? d.columns.map((c) => COLUMN_NAMES[c]).join(", ") : "ID・タイトル・更新日時のみ" });
  if (d.showCompleted === false) items.push({ name: "完了済み Issue", value: "非表示" });
  if (d.showChildren === false) items.push({ name: "子 Issue", value: "非表示" });
  return items;
}

// 「表示」の要約の1行。項目を「 ／ 」で区切り、全角の閉じ括弧の直後だけ前の空白を置かない（design/nod.pen PdYmE）
export function displaySummary(items: readonly DisplayItem[]): string {
  return items.map((item) => `${item.name} ${item.value}`).join(" ／ ").replaceAll("） ／", "）／");
}

// 保存ダイアログの注記。View に保存しないもの（検索欄の入力・プレビュー）が今の画面にあるときだけ返す
export function unsavedNote(search: IssueListSearch): string | null {
  const parts: string[] = [];
  if (search.q) parts.push(`検索欄の入力「${search.q}」`);
  if (search.preview) parts.push("プレビュー");
  return parts.length ? `${parts.join("と")}は保存しません` : null;
}
