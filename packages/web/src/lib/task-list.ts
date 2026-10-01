// 箇条書きの記号（- * + や 1. 1)）に続くタスクリストの [ ] / [x]
const TASK_MARKER = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/;

// Markdown の offset から始まるタスクリスト項目のチェックを付け外しした文字列を返す。
// offset は描画した li の元の位置（mdast の position.start.offset）。項目が見つからなければ null
export function toggleTaskAt(source: string, offset: number, checked: boolean): string | null {
  const match = TASK_MARKER.exec(source.slice(offset));
  if (!match) return null;
  const at = offset + (match[1] ?? "").length;
  return source.slice(0, at) + (checked ? "x" : " ") + source.slice(at + 1);
}
