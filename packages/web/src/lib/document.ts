import type { DocKind } from "../api/types";

export const KIND_LABELS: Record<DocKind, string> = { spec: "Spec", plan: "Plan", doc: "Doc" };

// 正の整数でない ID は、API を呼ばずに「見つかりません」を出す
export function parseDocumentId(raw: string): number | null {
  return /^[1-9]\d{0,14}$/.test(raw) ? Number(raw) : null;
}

// Document のタイトルは、省くとファイルの最初の「# 」見出しになる（spec）。
// ページの <h1> と同じ見出しを本文の先頭に重ねて出さないよう、同じなら省く。
export function stripLeadingTitle(content: string, title: string): string {
  const lines = content.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first < 0 || lines[first]?.trim() !== `# ${title}`) return content;
  const rest = lines.slice(first + 1);
  while (rest.length > 0 && rest[0]?.trim() === "") rest.shift();
  return rest.join("\n");
}
