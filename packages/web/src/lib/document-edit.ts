// 本文のクリックで編集に入るか。リンク・チェックボックスの操作と、テキストを選択したときのクリックでは入らない
export function shouldStartEditing(target: Element | null, selection: { isCollapsed: boolean } | null): boolean {
  if (!target || target.closest("a, input")) return false;
  return selection?.isCollapsed ?? true;
}
