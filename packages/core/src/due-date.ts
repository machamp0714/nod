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
