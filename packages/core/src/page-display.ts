import { NodError } from "./errors";
import { type ViewDisplay, type ViewGroupKey, validateViewDisplay } from "./view-display";

// Issue 一覧のページ（Issues・My Issues・Project 詳細・Cycle 詳細）ごとに保存する表示設定（#218）。
// 形は View の表示設定と同じで、既定と同じ値は持たない。タブは保存しない。
// My Issues の既定のグループ化は Status のため、「なし」を選んだことを groupBy: "none" で持てる
export type PageDisplay = Omit<ViewDisplay, "tab" | "groupBy"> & { groupBy?: ViewGroupKey | "none" };

const PAGE_RE = /^(issues|my-issues|project:[1-9]\d*|cycle:[1-9]\d*)$/;

export function validatePage(page: string): string {
  if (!PAGE_RE.test(page)) {
    throw new NodError("INVALID_ARGS", `表示設定を保存するページ「${page}」は使えません（使えるもの: issues, my-issues, project:<id>, cycle:<id>）`);
  }
  return page;
}

export function validatePageDisplay(value: unknown): PageDisplay {
  const { tab: _tab, ...display } = validateViewDisplay(value);
  const raw = value as Record<string, unknown>;
  if ("tab" in raw) throw new NodError("INVALID_ARGS", "ページの表示設定に tab は使えません（タブは保存しません）");
  return raw.groupBy === "none" ? { ...display, groupBy: "none" } : display;
}
