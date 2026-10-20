// 期日は時刻を持たない暦日なので、処理する端末のローカル09:00として解釈する。
export function dueDateAtNine(dueDate: string): string {
  const [year, month, day] = dueDate.split("-").map(Number);
  return new Date(year!, month! - 1, day!, 9).toISOString();
}
