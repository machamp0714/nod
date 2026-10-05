import { describe, expect, test } from "bun:test";
import { breakdownLabel, formatRate, formatScopeAdded, graphSeries, panelPeriod } from "./cycle-analytics";

describe("cycle-analytics", () => {
  test("formatRate・formatScopeAdded・breakdownLabel", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(1 / 3)).toBe("33%");
    expect(formatScopeAdded(2)).toBe("開始後 +2");
    expect(formatScopeAdded(-1)).toBe("開始後 -1");
    expect(formatScopeAdded(0)).toBe("");
    expect(breakdownLabel({ total: 5, done: 3 })).toBe("60% of 5");
    expect(breakdownLabel({ total: 0, done: 0 })).toBe("— of 0");
  });

  test("graphSeries は期間の全日を並べ、今日より後は null、Started は Completed に積み、Target は直線", () => {
    const r = graphSeries(
      [{ date: "2026-10-05", scope: 4, started: 1, completed: 0 }, { date: "2026-10-06", scope: 4, started: 1, completed: 2 }],
      "2026-10-05",
      "2026-10-08",
    );
    expect(r.days).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
    expect(r.scope).toEqual([4, 4, null, null]);
    expect(r.startedStack).toEqual([1, 3, null, null]);
    expect(r.completed).toEqual([0, 2, null, null]);
    expect(r.target).toEqual([0, 4 / 3, 8 / 3, 4]);
    expect(r.max).toBe(4);
  });

  test("panelPeriod は「10/06 – 10/19」と、現在の Cycle だけ今日から終了日までの残り日数を足す", () => {
    const cycle = { startDate: "2026-10-06", endDate: "2026-10-19" };
    expect(panelPeriod({ ...cycle, state: "current" }, "2026-10-14")).toBe("10/06 – 10/19 · 残り 5 日");
    expect(panelPeriod({ ...cycle, state: "current" }, "2026-10-19")).toBe("10/06 – 10/19 · 残り 0 日");
    expect(panelPeriod({ ...cycle, state: "upcoming" }, null)).toBe("10/06 – 10/19");
    expect(panelPeriod({ ...cycle, state: "completed" }, "2026-10-19")).toBe("10/06 – 10/19");
  });
});
