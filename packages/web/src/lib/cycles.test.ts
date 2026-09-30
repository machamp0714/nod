import { describe, expect, test } from "bun:test";
import { cycleLabel, defaultDestination, formatCyclePeriod } from "./cycles";

const c = (id: number, name: string, state: "current" | "upcoming" | "completed", startDate: string, workspace = "API") => ({
  id,
  name,
  state,
  startDate,
  workspace,
});

describe("Cycle の表示", () => {
  test("期間は同じ年なら終了日の年を省く", () => {
    expect(formatCyclePeriod({ startDate: "2026-09-08", endDate: "2026-09-21" })).toBe("2026-09-08 – 09-21");
    expect(formatCyclePeriod({ startDate: "2026-12-28", endDate: "2027-01-10" })).toBe("2026-12-28 – 2027-01-10");
  });

  test("同じ名前が別 Workspace にあるときだけキーを足す", () => {
    const all = [c(1, "Sprint 1", "current", "2026-10-01"), c(2, "Sprint 1", "upcoming", "2026-10-01", "WEB"), c(3, "Sprint 2", "upcoming", "2026-10-15")];
    expect(cycleLabel(all[0]!, all)).toBe("Sprint 1（Current） · API");
    expect(cycleLabel(all[2]!, all)).toBe("Sprint 2（Upcoming）");
  });

  test("移動先の既定は現在の Cycle、移動元が現在なら次の予定", () => {
    const list = [c(1, "S1", "completed", "2026-09-01"), c(2, "S2", "current", "2026-09-15"), c(3, "S3", "upcoming", "2026-09-29"), c(4, "S4", "upcoming", "2026-10-13")];
    expect(defaultDestination(list[0]!, list)?.id).toBe(2);
    expect(defaultDestination(list[1]!, list)?.id).toBe(3);
    expect(defaultDestination(list[2]!, list)?.id).toBe(2);
    expect(defaultDestination(list[0]!, [list[0]!])).toBeUndefined();
  });
});
