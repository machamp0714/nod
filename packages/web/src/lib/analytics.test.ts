import { describe, expect, test } from "bun:test";
import {
  axisDate,
  cleanAnalyticsSearch,
  cycleOptions,
  cycleProblem,
  formatHours,
  labelEvery,
  llmColors,
  milestoneGroups,
  milestoneProblem,
  niceTicks,
  parseAnalyticsSearch,
  statsQueryString,
  statsRange,
  withProject,
} from "./analytics";

describe("parseAnalyticsSearch / cleanAnalyticsSearch", () => {
  test("正しい値は残し、知らない値は捨てる", () => {
    expect(parseAnalyticsSearch({ by: "day", range: 90, workspace: "api", project: 3 })).toEqual({ by: "day", range: 90, workspace: "API", project: "3" });
    expect(parseAnalyticsSearch({ project: "3", milestone: 5 })).toEqual({ project: "3", milestone: "5" });
    const invalid = parseAnalyticsSearch({ by: "month", range: 90, workspace: " ", project: "検索", milestone: "α" });
    expect(invalid).toEqual({ by: undefined, range: undefined, workspace: undefined, project: undefined, milestone: undefined });
    expect(Object.keys(invalid)).toEqual(["by", "range", "workspace", "project", "milestone"]); // 元の search の不正な値を上書きする
    expect(parseAnalyticsSearch({ range: 7 })).toEqual({ range: undefined }); // 7 は日のプリセットで、既定の週にはない
    expect(Object.keys(parseAnalyticsSearch({}))).toEqual([]);
  });

  test("Cycle は ID か none（Cycle なし）を残す", () => {
    expect(parseAnalyticsSearch({ cycle: 4 })).toEqual({ cycle: "4" });
    expect(parseAnalyticsSearch({ cycle: "None" })).toEqual({ cycle: "none" });
    expect(parseAnalyticsSearch({ cycle: "Sprint 1" })).toEqual({ cycle: undefined });
    expect(cleanAnalyticsSearch({ cycle: "none" })).toEqual({ cycle: "none" });
  });

  test("既定値（週・直近12週）は URL に残さない", () => {
    expect(cleanAnalyticsSearch({ by: "week", range: 12 })).toEqual({});
    expect(cleanAnalyticsSearch({ by: "day", range: 30, project: "2" })).toEqual({ by: "day", project: "2" });
    expect(cleanAnalyticsSearch({ by: "day", range: 12 })).toEqual({ by: "day" });
    expect(cleanAnalyticsSearch({ milestone: "5", project: undefined })).toEqual({ milestone: "5" });
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
    expect(statsQueryString({ project: "2", milestone: "5" }, today, "UTC")).toBe(
      "by=week&from=2026-07-13&to=2026-09-29&tz=UTC&project=2&milestone=5",
    );
    expect(statsQueryString({ workspace: "API", cycle: "none" }, today, "UTC")).toBe(
      "by=week&from=2026-07-13&to=2026-09-29&tz=UTC&workspace=API&cycle=none",
    );
  });
});

describe("Milestone の選択肢", () => {
  const projects = [{ id: 1, name: "検索" }, { id: 2, name: "決済" }];
  const milestones = [
    { id: 10, projectId: 2, name: "α" },
    { id: 11, projectId: 1, name: "α" },
    { id: 12, projectId: 1, name: "β" },
  ];
  test("Project を選んでいればその Project の Milestone だけ、なければ Project ごとに見出しをつけて並べる", () => {
    expect(milestoneGroups(milestones, projects, "1")).toEqual([
      { label: null, options: [{ value: "11", label: "α" }, { value: "12", label: "β" }] },
    ]);
    expect(milestoneGroups(milestones, projects, undefined)).toEqual([
      { label: "決済", options: [{ value: "10", label: "α" }] },
      { label: "検索", options: [{ value: "11", label: "α" }, { value: "12", label: "β" }] },
    ]);
    expect(milestoneGroups([], projects, undefined)).toEqual([]);
  });

  test("Project を変えると、その Project にない Milestone の選択を外す", () => {
    expect(withProject({ by: "day", milestone: "11" }, "1", milestones)).toEqual({ by: "day", project: "1", milestone: "11" });
    expect(withProject({ project: "1", milestone: "11" }, "2", milestones)).toEqual({ project: "2", milestone: undefined });
    expect(withProject({ project: "1", milestone: "11" }, undefined, milestones)).toEqual({ project: undefined, milestone: "11" });
    expect(withProject({ milestone: "99" }, "1", milestones)).toEqual({ project: "1", milestone: undefined });
    // 一覧を読み込む前は判断できないため外さない（食い違えば milestoneProblem が知らせる）
    expect(withProject({ milestone: "11" }, "2", undefined)).toEqual({ project: "2", milestone: "11" });
  });

  test("消えた Milestone や、URL の Project と食い違う Milestone は API を呼ばずに知らせる", () => {
    expect(milestoneProblem({ milestone: "11" }, undefined)).toBeNull(); // 読み込み中
    expect(milestoneProblem({ milestone: "11" }, milestones)).toBeNull();
    expect(milestoneProblem({ project: "1", milestone: "11" }, milestones)).toBeNull();
    expect(milestoneProblem({ milestone: "99" }, milestones)).toBe("条件の Milestone（99）が見つかりません");
    expect(milestoneProblem({ project: "2", milestone: "11" }, milestones)).toBe("条件の Milestone（α）は条件の Project のものではありません");
  });
});

describe("Cycle の選択肢", () => {
  const cycles = [
    { id: 1, name: "Sprint 12", workspace: "API" },
    { id: 2, name: "Sprint 12", workspace: "NOD" },
    { id: 3, name: "Sprint 13", workspace: "API" },
    { id: 4, name: "Design Week", workspace: "WEB" },
  ];
  test("名前をそのまま出し、同じ名前の Cycle がほかの Workspace にあるときだけ Workspace のキーを添える", () => {
    expect(cycleOptions(cycles)).toEqual([
      { value: "1", label: "Sprint 12 · API" },
      { value: "2", label: "Sprint 12 · NOD" },
      { value: "3", label: "Sprint 13" },
      { value: "4", label: "Design Week" },
    ]);
  });

  test("消えた Cycle の ID は API を呼ばずに知らせる。none は Cycle なし", () => {
    expect(cycleProblem({ cycle: "9" }, undefined)).toBeNull();
    expect(cycleProblem({ cycle: "1" }, cycles)).toBeNull();
    expect(cycleProblem({ cycle: "none" }, cycles)).toBeNull();
    expect(cycleProblem({ cycle: "9" }, cycles)).toBe("条件の Cycle（9）が見つかりません");
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

test("LLM の色は claude-code・codex を固定し、ほかは順に別の色にする", () => {
  expect([...llmColors(["gemini", "claude-code", "codex", "aider"])]).toEqual([
    ["gemini", "var(--ws-a)"],
    ["claude-code", "var(--claude)"],
    ["codex", "var(--codex)"],
    ["aider", "var(--ws-b)"],
  ]);
});
