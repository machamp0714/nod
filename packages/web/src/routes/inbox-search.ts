import { parseSelectedSearch } from "./search";
export type InboxTab = "questions" | "notifications" | "all";
export type InboxSearch = { selected?: string; tab?: InboxTab };
export function parseInboxSearch(search: Record<string, unknown>): InboxSearch {
  const tab = search.tab === "all" || search.tab === "notifications" ? search.tab : undefined;
  return { ...parseSelectedSearch(search), ...(tab ? { tab } : {}) };
}
