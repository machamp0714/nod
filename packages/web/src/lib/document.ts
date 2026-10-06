import type { DocKind } from "../api/types";
import type { Tone } from "./meta";

export const KIND_LABELS: Record<DocKind, string> = { spec: "Spec", plan: "Plan", doc: "Doc" };
export const KIND_TONES: Record<DocKind, Tone> = { spec: "accent", plan: "ready", doc: "muted" };

// 一覧や表示画面の日付（例: 9月27日）。読めない値は「記録なし」
export function documentDate(iso: string): string {
  const at = new Date(iso);
  return Number.isFinite(at.getTime()) ? at.toLocaleDateString("ja-JP", { month: "long", day: "numeric" }) : "記録なし";
}

// Documents ディレクトリの下のファイルは、ルートからの相対パスで見せる
export function displayPath(path: string, root: string | undefined): string {
  if (!root) return path;
  const base = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

// Issue ID の入力を正規化する（例: " api-8 " → "API-8"）。形が違えば null
export function normalizeIssueRef(raw: string): string | null {
  const value = raw.trim().toUpperCase();
  return /^[A-Z0-9]{2,6}-\d+$/.test(value) ? value : null;
}

// 正の整数でない ID は、API を呼ばずに「見つかりません」を出す
export function parseDocumentId(raw: string): number | null {
  return /^[1-9]\d{0,14}$/.test(raw) ? Number(raw) : null;
}

// Document のタイトルは、省くとファイルの最初の「# 」見出しになる（spec）。
// ページの <h1> と同じ見出しを本文の先頭に重ねて出さないよう、同じなら省く。
export function stripLeadingTitle(content: string, title: string): string {
  const lines = content.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() !== "");
  // core の leadingTitle と同じ規則（# の後の空白は何文字でも・タブでもよく、前後の空白は無視する）
  const heading = first < 0 ? undefined : /^#\s+(.+?)\s*$/.exec(lines[first] ?? "")?.[1]?.trim();
  if (heading === undefined || heading !== title) return content;
  const rest = lines.slice(first + 1);
  while (rest.length > 0 && rest[0]?.trim() === "") rest.shift();
  return rest.join("\n");
}

// Document の本文の画像の src。.md からの相対パス（images/x.png・./images/x.png）だけを server の配信 URL にする。
// スキーム付き・/ 始まり・../ 始まり（.md より上を指すもの。spec で表示しないと決めた）はそのまま返す。
// react-markdown は src を encode 済みで渡す（例: 画面 → %E7...）。server は各セグメントを1回だけ decode するため、
// 各セグメントを decode してから encode し、生でも encode 済みでも結果を1回 encode した形にそろえる
export function documentAssetSrc(documentId: number, src: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("/") || src.startsWith("../")) return src;
  const rel = src.replace(/^(\.\/)+/, "");
  if (rel.startsWith("../")) return src;
  return `/api/documents/${documentId}/assets/${rel.split("/").map((seg) => encodeURIComponent(decodeSegment(seg))).join("/")}`;
}

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}
