// Issue のリマインダー（#47）。端末のタイムゾーンで入力を解釈し、server へは ISO で送る（スヌーズと同じ）

const pad = (n: number) => String(n).padStart(2, "0");

// 「10/02 09:00」（Pencil『リマインダー行｜状態』）
export function formatReminderAt(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 編集欄の初期値。date は YYYY-MM-DD、time は HH:MM
export function reminderInputs(iso: string | null): { date: string; time: string } {
  if (iso === null) return { date: "", time: "09:00" };
  const d = new Date(iso);
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

export type ReminderInput = { at: Date } | { error: "invalid" | "past" };

// date（YYYY-MM-DD）と time（HH:MM）を端末の日時として読む。存在しない日付は invalid、今より前は past
export function parseReminderInput(date: string, time: string, now: Date = new Date()): ReminderInput {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return { error: "invalid" };
  const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const at = new Date(y, m - 1, day, Number(t[1]), Number(t[2]));
  if (at.getMonth() !== m - 1 || at.getDate() !== day || Number(t[1]) > 23 || Number(t[2]) > 59) return { error: "invalid" };
  return at.getTime() > now.getTime() ? { at } : { error: "past" };
}
