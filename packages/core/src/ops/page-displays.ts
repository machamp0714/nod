import type { Database } from "bun:sqlite";
import { type PageDisplay, validatePage, validatePageDisplay } from "../page-display";

// 保存したすべてのページの表示設定。行は少ない（ページの数だけ）ので、まとめて返す
export function listPageDisplays(db: Database): Record<string, PageDisplay> {
  const rows = db.query("SELECT page, display FROM page_displays ORDER BY page").all() as { page: string; display: string }[];
  return Object.fromEntries(rows.map((r) => [r.page, JSON.parse(r.display) as PageDisplay]));
}

// ページの表示設定を丸ごと置き換える
export function setPageDisplay(db: Database, page: string, display: unknown): PageDisplay {
  validatePage(page);
  const d = validatePageDisplay(display);
  db.query(
    "INSERT INTO page_displays (page, display, updated_at) VALUES (?, ?, ?) ON CONFLICT(page) DO UPDATE SET display = excluded.display, updated_at = excluded.updated_at",
  ).run(page, JSON.stringify(d), new Date().toISOString());
  return d;
}

// 「既定に戻す」。保存がなくても失敗しない
export function deletePageDisplay(db: Database, page: string): void {
  validatePage(page);
  db.query("DELETE FROM page_displays WHERE page = ?").run(page);
}
