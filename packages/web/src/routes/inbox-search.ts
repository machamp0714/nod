import { parseSelectedSearch } from "./search";
export type InboxTab = "questions" | "notifications" | "all";
// view は通知タブの表示。snoozed ならスヌーズ中の通知（#43）
export type InboxSearch = { selected?: string; tab?: InboxTab; view?: "snoozed" };
export function parseInboxSearch(search: Record<string, unknown>): InboxSearch {
  const tab = search.tab === "all" || search.tab === "notifications" ? search.tab : undefined;
  const view = tab === "notifications" && search.view === "snoozed" ? search.view : undefined;
  return { ...parseSelectedSearch(search), ...(tab ? { tab } : {}), ...(view ? { view } : {}) };
}
