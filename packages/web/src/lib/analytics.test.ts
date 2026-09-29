import { describe, expect, test } from "bun:test";
import {
  axisDate,
  cleanAnalyticsSearch,
  formatHours,
  labelEvery,
  niceTicks,
  parseAnalyticsSearch,
  statsQueryString,
  statsRange,
} from "./analytics";

describe("parseAnalyticsSearch / cleanAnalyticsSearch", () => {
  test("正しい値は残し、知らない値は捨てる", () => {
    expect(parseAnalyticsSearch({ by: "day", range: 90, workspace: "api", project: 3 })).toEqual({ by: "day", range: 90, workspace: "API", project: "3" });
    const invalid = parseAnalyticsSearch({ by: "month", range: 90, workspace: " ", project: "検索" });
    expect(invalid).toEqual({ by: undefined, range: undefined, workspace: undefined, project: undefined });
    expect(Object.keys(invalid)).toEqual(["by", "range", "workspace", "project"]); // 元の search の不正な値を上書きする
    expect(parseAnalyticsSearch({ range: 7 })).toEqual({ range: undefined }); // 7 は日のプリセットで、既定の週にはない
    expect(Object.keys(parseAnalyticsSearch({}))).toEqual([]);
  });

  test("既定値（週・直近12週）は URL に残さない", () => {
    expect(cleanAnalyticsSearch({ by: "week", range: 12 })).toEqual({});
    expect(cleanAnalyticsSearch({ by: "day", range: 30, project: "2" })).toEqual({ by: "day", project: "2" });
    expect(cleanAnalyticsSearch({ by: "day", range: 12 })).toEqual({ by: "day" });
  });
});

describe("statsRange / statsQueryString", () => {
  const today = new Date(2026, 8, 29, 15); // 2026-09-29（火）
  test("日は今日を含む直近 n 日、週は月曜始まりで直近 n 週", () => {
    expect(statsRange("day", 30, today)).toEqual({ from: "2026-08-31", to: "2026-09-29" });
    expect(statsRange("week", 12, today)).toEqual({ from: "2026-07-13", to: "2026-09-29" });
    expect(statsRange("week", 1, new Date(2026, 8, 27))).toEqual({ from: "2026-09-21", to: "2026-09-27" }); // 日曜
  });

  test("tz と絞り込みを API のクエリにする", () => {
    expect(statsQueryString({ by: "day", range: 7, workspace: "API", project: "2" }, today, "Asia/Tokyo")).toBe(
      "by=day&from=2026-09-23&to=2026-09-29&tz=Asia%2FTokyo&workspace=API&project=2",
    );
    expect(statsQueryString({}, today, "UTC")).toBe("by=week&from=2026-07-13&to=2026-09-29&tz=UTC");
  });
});

describe("表示の書式と目盛り", () => {
  test("作業時間は時間の小数1桁、記録なしは —", () => {
    expect(formatHours(192)).toBe("3.2h");
    expect(formatHours(6270)).toBe("104.5h");
    expect(formatHours(0)).toBe("0.0h");
    expect(formatHours(null)).toBe("—");
  });

  test("軸の日付は M/D", () => {
    expect(axisDate("2026-07-07")).toBe("7/7");
    expect(axisDate("2026-12-31")).toBe("12/31");
  });

  test("目盛りは 1・2・5 刻みで最大値を覆い、件数は1未満の刻みにしない", () => {
    expect(niceTicks(8)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(9)).toEqual([0, 5, 10]);
    expect(niceTicks(1)).toEqual([0, 1]);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(0.5, 0.1)).toEqual([0, 0.2, 0.4, 0.6]);
  });

  test("軸の文字は12個以下になるよう間引く", () => {
    expect(labelEvery(12)).toBe(1);
    expect(labelEvery(30)).toBe(3);
    expect(labelEvery(90)).toBe(8);
  });
});
