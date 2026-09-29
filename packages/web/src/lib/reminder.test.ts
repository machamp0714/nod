import { describe, expect, test } from "bun:test";
import { formatReminderAt, parseReminderInput, reminderInputs } from "./reminder";

const now = new Date(2026, 8, 30, 12, 0);

describe("リマインダーの入力と表示（#47）", () => {
  test("端末の日時として読み、過去と存在しない日付を分けて返す", () => {
    expect(parseReminderInput("2026-10-02", "09:00", now)).toEqual({ at: new Date(2026, 9, 2, 9, 0) });
    expect(parseReminderInput("2026-09-28", "09:00", now)).toEqual({ error: "past" });
    expect(parseReminderInput("2026-09-30", "12:00", now)).toEqual({ error: "past" });
    expect(parseReminderInput("2026-02-30", "09:00", now)).toEqual({ error: "invalid" });
    expect(parseReminderInput("", "09:00", now)).toEqual({ error: "invalid" });
    expect(parseReminderInput("2026-10-02", "", now)).toEqual({ error: "invalid" });
  });

  test("表示は MM/DD HH:MM、編集欄は設定済みの値か 09:00 から始める", () => {
    const iso = new Date(2026, 9, 2, 9, 5).toISOString();
    expect(formatReminderAt(iso)).toBe("10/02 09:05");
    expect(reminderInputs(iso)).toEqual({ date: "2026-10-02", time: "09:05" });
    expect(reminderInputs(null)).toEqual({ date: "", time: "09:00" });
  });
});
