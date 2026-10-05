import { describe, expect, test } from "bun:test";
import { cycleLabel, formatCyclePeriod } from "./cycles";

describe("Cycle の表示", () => {
  test("期間は同じ年なら終了日の年を省く", () => {
    expect(formatCyclePeriod({ startDate: "2026-09-08", endDate: "2026-09-21" })).toBe("2026-09-08 – 09-21");
    expect(formatCyclePeriod({ startDate: "2026-12-28", endDate: "2027-01-10" })).toBe("2026-12-28 – 2027-01-10");
  });

  test("cycleLabel は Workspace に関係なく「名前（状態）」", () => {
    expect(cycleLabel({ name: "Sprint 12", state: "current" })).toBe("Sprint 12（Current）");
  });
});
