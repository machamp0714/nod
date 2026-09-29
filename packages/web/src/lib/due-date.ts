export { isOverdue, localToday } from "@nod/core/src/due-date";

// 期限は時刻なしの暦日。Date に変換せず文字列から読み、タイムゾーンで日付をずらさない
export function formatDueDate(dueDate: string | null, today: string): string | null {
  const m = dueDate ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate) : null;
  if (!m) return null;
  const monthDay = `${Number(m[2])}月${Number(m[3])}日`;
  return m[1] === today.slice(0, 4) ? monthDay : `${m[1]}年${monthDay}`;
}

export function formatEstimate(estimate: number | null): string | null {
  return estimate === null ? null : `${estimate} pt`;
}

// Properties の見積もり入力。空は解除（null）、1〜100 の整数以外は undefined（送らない）
export function parseEstimateInput(text: string): number | null | undefined {
  const value = text.trim();
  if (value === "") return null;
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n >= 1 && n <= 100 ? n : undefined;
}
