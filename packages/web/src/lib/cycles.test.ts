import { describe, expect, test } from "bun:test";
import { currentCycleLink, cycleChoices, cycleLabel, formatCadence, formatCyclePeriod } from "./cycles";

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

describe("cycleChoices", () => {
  const c = (id: number, name: string, state: "current" | "upcoming" | "completed", startDate: string) => ({ id, name, state, startDate });
  const cycles = [c(1, "S1", "completed", "2026-09-01"), c(3, "S3", "upcoming", "2026-10-15"), c(2, "S2", "current", "2026-10-01")];

  test("終了していない Cycle を current を先に開始日の順で並べる", () => {
    expect(cycleChoices(cycles, null)).toEqual([{ id: 2, name: "S2" }, { id: 3, name: "S3" }]);
  });

  test("今付いている Cycle は終了していても末尾に残し、重ねて出さない", () => {
    expect(cycleChoices(cycles, { id: 1, name: "S1" })).toEqual([{ id: 2, name: "S2" }, { id: 3, name: "S3" }, { id: 1, name: "S1" }]);
    expect(cycleChoices(cycles, { id: 3, name: "S3" })).toEqual([{ id: 2, name: "S2" }, { id: 3, name: "S3" }]);
    expect(cycleChoices([], { id: 1, name: "S1" })).toEqual([{ id: 1, name: "S1" }]);
  });
});
