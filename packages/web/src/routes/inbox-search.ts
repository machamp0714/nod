import { parseSelectedSearch } from "./search";
export type InboxSearch = { selected?: string; tab?: "questions" | "all" };
export function parseInboxSearch(search: Record<string, unknown>): InboxSearch {
  return { ...parseSelectedSearch(search), ...(search.tab === "all" ? { tab: "all" as const } : {}) };
}
