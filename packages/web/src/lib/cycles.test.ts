import { describe, expect, test } from "bun:test";
import { currentCycleLink, cycleLabel, formatCadence, formatCyclePeriod } from "./cycles";

describe("Cycle の表示", () => {
  test("期間は同じ年なら終了日の年を省く", () => {
    expect(formatCyclePeriod({ startDate: "2026-09-08", endDate: "2026-09-21" })).toBe("2026-09-08 – 09-21");
    expect(formatCyclePeriod({ startDate: "2026-12-28", endDate: "2027-01-10" })).toBe("2026-12-28 – 2027-01-10");
  });

  test("cycleLabel は Workspace に関係なく「名前（状態）」", () => {
    expect(cycleLabel({ name: "Sprint 12", state: "current" })).toBe("Sprint 12（Current）");
  });

  test("formatCadence は周期・持ち越し・次の Cycle を1行で出す", () => {
    const cycles = [
      { name: "Cycle 4", startDate: "2026-10-05", state: "current" as const },
      { name: "Cycle 5", startDate: "2026-10-19", state: "upcoming" as const },
    ];
    expect(formatCadence({ weeks: 2, autoCarryOver: true, anchorDate: "2026-09-07", nextNumber: 6, updatedBy: "me", updatedAt: "" }, cycles)).toBe(
      "2週間ごと · 自動持ち越し ON · 次は Cycle 5（10-19〜）",
    );
    expect(formatCadence(null, cycles)).toBe("周期は未設定です");
  });

  test("currentCycleLink は今の Cycle の詳細、なければ一覧を指す", () => {
    expect(currentCycleLink(undefined)).toBeNull();
    expect(
      currentCycleLink([
        { id: 4, name: "Cycle 4", state: "current" },
        { id: 5, name: "Cycle 5", state: "upcoming" },
      ]),
    ).toEqual({ to: "/cycles/4", label: "Cycle 4" });
    expect(currentCycleLink([{ id: 5, name: "Cycle 5", state: "upcoming" }])).toEqual({ to: "/cycles", label: "なし" });
  });
});
