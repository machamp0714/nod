import { expect, test } from "bun:test";
import { cleanAnalyticsSearch, parseAnalyticsSearch, statsQueryString, sprintProblem } from "./analytics";
import { graphSeries } from "./cycle-analytics";

test("分析の相対current・固定UUID・none・未解決条件をURLとAPIに保持する", () => {
  for (const sprint of ["current", "none", "fef285ef-36a2-4c75-bb92-b03b947014ac", "unresolved:cycle:99"]) {
    const search = cleanAnalyticsSearch(parseAnalyticsSearch({ sprint }));
    expect(search).toEqual({ sprint });
    expect(new URLSearchParams(statsQueryString(search, new Date("2026-10-26T00:00:00Z"), "UTC")).get("sprint")).toBe(sprint);
  }
  expect(sprintProblem({ sprint: "current" }, [])).toBeNull();
  expect(sprintProblem({ sprint: "unresolved:cycle:99" }, [])).toContain("見つかりません");
});

test("日次履歴のnullを線の欠落として保ち、不明件数を0で補わない", () => {
  const series = graphSeries([
    { date: "2026-01-01", scope: null, started: null, completed: null, unknown: 2 },
    { date: "2026-01-02", scope: 2, started: 0, completed: 1, unknown: 0 },
  ], "2026-01-01", "2026-01-02");
  expect(series.scope).toEqual([null, 2]);
  expect(series.startedStack).toEqual([null, 1]);
  expect(series.completed).toEqual([null, 1]);
  expect(series.unknown).toEqual([2, 0]);
});
