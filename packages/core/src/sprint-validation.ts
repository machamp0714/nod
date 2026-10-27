import { createHash } from "node:crypto";
import { NodError } from "./errors";

export function invalidSprint(message: string): never { throw new NodError("INVALID_ARGS", message); }
export function sprintObject(value: unknown, keys: readonly string[], name = "入力"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidSprint(`${name}はオブジェクトで指定してください`);
  const row = value as Record<string, unknown>;
  const unknown = Object.keys(row).filter(key => !keys.includes(key));
  if (unknown.length) invalidSprint(`${name}の ${unknown.join(", ")} は受け付けません`);
  return row;
}
export function sprintText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) return invalidSprint(`${name}は空でない文字列で指定してください`);
  return value.trim();
}
export function sprintVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalidSprint("expectedVersionは0以上の整数で指定してください");
  return value as number;
}
export function sprintHash(value: unknown): string {
  const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object" ? `{${Object.keys(v).sort().map(key => `${JSON.stringify(key)}:${canonical(v[key])}`).join(",")}}` : JSON.stringify(v);
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function sprintPeriod(start: unknown, end: unknown, zone: unknown) {
  const validDate = (value: unknown): string => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01" || value > "9998-12-31") return invalidSprint("期間は実在するYYYY-MM-DDで指定してください");
    const time = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) return invalidSprint("期間の日付が存在しません");
    return value;
  };
  const startDate = validDate(start), endDate = validDate(end), timezone = sprintText(zone, "timezone");
  if (startDate > endDate) invalidSprint("終了日は開始日以降にしてください");
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }); }
  catch { return invalidSprint("timezoneは有効なIANAタイムゾーンで指定してください"); }
  // 暦日の最初の瞬間を求める。固定24時間の加算にせず、DSTの23/25時間日もそのtimezoneで解決する。
  const dateAt = (time: number): string => {
    const parts = formatter.formatToParts(new Date(time));
    const part = (type: string) => parts.find(p => p.type === type)!.value;
    return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
  };
  const midnight = (date: string): string => {
    const utc = Date.parse(`${date}T00:00:00.000Z`);
    let low = utc - 172800000, high = utc + 172800000;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (dateAt(mid) < date) low = mid + 1; else high = mid;
    }
    if (dateAt(low) !== date) return invalidSprint(`${timezone}に${date}は存在しません`);
    return new Date(low).toISOString();
  };
  const nextDate = new Date(Date.parse(`${endDate}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
  return { startDate, endDate, timezone, startsAt: midnight(startDate), endsAt: midnight(nextDate) };
}
