import { NodError } from "./errors";

// v2 migrationでも使う割当規則V1。既存DBの移行結果を変えないため将来も変更しない。
const INITIAL_COLORS = [
  "#7C5CFF", "#0D9768", "#C36B04", "#DB2777",
  "#2563EB", "#0F766E", "#B91C1C", "#6D28D9",
  "#A16207", "#0369A1", "#4D7C0F", "#BE123C",
];
const INITIAL_SET = new Set(INITIAL_COLORS);
const BACKGROUNDS = [0xFFFFFF, 0xF5F6F8, 0xEEF0F3, 0xFAFBFC, 0xE8EBFC, 0xFDF0D8];
const LINEAR = Array.from({ length: 256 }, (_, n) => {
  const c = n / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
function luminance(value: number): number {
  return 0.2126 * LINEAR[(value >> 16) & 255]! + 0.7152 * LINEAR[(value >> 8) & 255]! + 0.0722 * LINEAR[value & 255]!;
}
const MAX_LUMINANCE = Math.min(...BACKGROUNDS.map((background) => (luminance(background) + 0.05) / 3 - 0.05));

export function* workspaceColorCandidatesV1(): Generator<string> {
  yield* INITIAL_COLORS;
  for (let i = 0; i <= 0xFFFFFF; i++) {
    // 奇数乗算は24bit空間の順列。キー特例や小さな登録数上限を作らない。
    const value = (i * 0x9E3779) & 0xFFFFFF;
    const r = value >> 16;
    const g = (value >> 8) & 255;
    const b = value & 255;
    if (Math.max(r, g, b) - Math.min(r, g, b) < 40 || luminance(value) > MAX_LUMINANCE) continue;
    const color = `#${value.toString(16).padStart(6, "0").toUpperCase()}`;
    if (!INITIAL_SET.has(color)) yield color;
  }
}

export function firstUnusedColor(used: ReadonlySet<string>, candidates: Iterable<string>): string {
  const iterator = candidates[Symbol.iterator]();
  // 移行で同じiteratorを使い続けられるよう、最初の空きでiteratorを閉じない。
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    if (!used.has(next.value)) return next.value;
  }
  throw new NodError(
    "WORKSPACE_COLOR_EXHAUSTED",
    "Workspace に割り当てられる未使用の色がありません。色の候補を拡張した nod が必要です",
  );
}

export function allocateWorkspaceColor(used: ReadonlySet<string>): string {
  return firstUnusedColor(used, workspaceColorCandidatesV1());
}
