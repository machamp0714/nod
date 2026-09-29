import type { Status } from "./types";

// 期限は時刻なしの暦日。利用者の端末のローカル日付で「今日」を決める
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// 期限超過：done / canceled 以外で、期限が今日より前。当日は超過にしない
export function isOverdue(issue: { dueDate: string | null; status: Status }, today: string): boolean {
  return issue.dueDate !== null && issue.status !== "done" && issue.status !== "canceled" && issue.dueDate < today;
}

// 期限の下限。日付欄のキーボード入力途中（年の1桁目で 0002 年など）の値を期限として受け付けない
export const MIN_DUE_DATE = "1900-01-01";

// YYYY-MM-DD の実在する暦日で、下限以降か
export function isValidDueDateInput(dueDate: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(2000, 0, 1));
  date.setUTCFullYear(y, mo - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d && dueDate >= MIN_DUE_DATE;
}
