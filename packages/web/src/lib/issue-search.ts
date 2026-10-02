// 全画面の Issue 検索（Shift + Cmd + F）。API の q は説明も対象にするため、ここで ID とタイトルの一致だけに絞る

export const ISSUE_SEARCH_LIMIT = 20;

interface ShortcutKey {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

// Mac は Shift + Cmd + F、それ以外は Shift + Ctrl + F
export function isIssueSearchShortcut(event: ShortcutKey): boolean {
  return event.key.toLowerCase() === "f" && event.shiftKey && (event.metaKey || event.ctrlKey) && !event.altKey;
}

export function matchIssueSearch<T extends { id: string; title: string }>(issues: readonly T[], query: string, limit = ISSUE_SEARCH_LIMIT): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const found = issues.filter((issue) => issue.id.toLowerCase().includes(needle) || issue.title.toLowerCase().includes(needle));
  // 件数の上限で切っても目的の Issue が落ちないよう、ID の完全一致を先頭に置く（ほかはサーバーの並び順のまま）
  const exact = found.filter((issue) => issue.id.toLowerCase() === needle);
  return [...exact, ...found.filter((issue) => issue.id.toLowerCase() !== needle)].slice(0, limit);
}
