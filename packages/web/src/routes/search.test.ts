import { describe, expect, test } from "bun:test";
import {
  cleanIssueListSearch,
  cleanMyIssuesSearch,
  cleanProjectIssuesSearch,
  defaultGroupBy,
  defaultIssueColumns,
  type IssueListSearch,
  DEFAULT_ISSUE_COLUMNS, ISSUE_COLUMNS,
  replacesIssueListHistory,
  cleanProjectsSearch,
  parseIssueListSearch,
  parseProjectsSearch,
  parseSelectedSearch,
} from "./search";

describe("parseIssueListSearch", () => {
  test("正しい値はそのまま残す", () => {
    expect(parseIssueListSearch({ tab: "ready", layout: "board", q: "N+1" })).toEqual({ tab: "ready", layout: "board", q: "N+1" });
  });

  test("不正なタブと表示方法は既定値で上書きする", () => {
    expect(parseIssueListSearch({ tab: "foo", layout: "grid", q: "" })).toEqual({ tab: "all", layout: "list" });
    expect(parseIssueListSearch({ tab: 1, layout: null })).toEqual({ tab: "all", layout: "list" });
  });

  test("指定のないキーは追加しない", () => {
    expect(parseIssueListSearch({})).toEqual({});
    expect(parseIssueListSearch({ tab: "ready" })).toEqual({ tab: "ready" });
    expect(parseIssueListSearch({ tab: "delegated" })).toEqual({ tab: "delegated" });
  });

  test("数字だけの検索語（ルーターが数値にしたもの）は文字列に戻す", () => {
    expect(parseIssueListSearch({ q: 128 })).toEqual({ q: "128" });
  });
});

describe("cleanIssueListSearch", () => {
  test("既定値のキーを除き、URL を短く保つ", () => {
    expect(cleanIssueListSearch({ tab: "all", layout: "list", q: "" })).toEqual({});
    expect(cleanIssueListSearch({ tab: "ready", layout: "list", q: "api" })).toEqual({ tab: "ready", q: "api" });
  });
});

describe("parseSelectedSearch と parseProjectsSearch", () => {
  test("selected は文字列だけを受け付ける", () => {
    expect(parseSelectedSearch({ selected: "API-8" })).toEqual({ selected: "API-8" });
    expect(parseSelectedSearch({ selected: 8 })).toEqual({});
  });

  test("Projects のタブは active、completed、all だけを受け付け、active は URL に残さない", () => {
    expect(parseProjectsSearch({ tab: "completed" })).toEqual({ tab: "completed" });
    expect(parseProjectsSearch({ tab: "zzz" })).toEqual({ tab: "active" });
    expect(parseProjectsSearch({ tab: 1 })).toEqual({ tab: "active" });
    expect(parseProjectsSearch({})).toEqual({});
    expect(cleanProjectsSearch({ tab: "active" })).toEqual({});
    expect(cleanProjectsSearch({ tab: "all" })).toEqual({ tab: "all" });
  });
});

describe("parseIssueListSearch の絞り込み条件", () => {
  test("Workspace は大文字にし、ステータスは知っているものだけ、Project は数字の ID だけを残す", () => {
    expect(
      parseIssueListSearch({ workspace: ["api", "API", " nod "], status: ["todo", "wip"], project: 3, label: ["bug", "", "bug"] }),
    ).toEqual({ workspace: ["API", "NOD"], status: ["todo"], project: "3", label: ["bug"] });
  });

  test("1つだけの値は文字列でも受け付け、不正な値は捨てる", () => {
    expect(parseIssueListSearch({ workspace: "blog", status: "done", label: "perf" })).toEqual({
      workspace: ["BLOG"],
      status: ["done"],
      label: ["perf"],
    });
    expect(parseIssueListSearch({ status: ["wip"], project: "abc", workspace: [null, {}], label: {} })).toEqual({});
  });

  test("空の条件は URL に残さない", () => {
    expect(cleanIssueListSearch({ workspace: [], status: ["todo"], project: "", label: [] })).toEqual({ status: ["todo"] });
  });
});


describe("表示設定のURL", () => {
  test("並び順・方向・空の列選択を往復できる", () => {
    const search = { sort: "updatedAt", direction: "desc", columns: [] } as const;
    expect(parseIssueListSearch({ ...cleanIssueListSearch({ ...search, columns: [] }) })).toEqual({ ...search, columns: [] });
    expect(parseIssueListSearch({ columns: ["pr", "status", "pr"] }).columns).toEqual(["status", "pr"]);
  });
  test("不正値は安全な既定値で上書きし古いURLを維持する", () => {
    for (const columns of [null, "pr", {}, ["unknown"], ["pr", 1]]) {
      expect(parseIssueListSearch({ sort: "bad", direction: "bad", columns })).toEqual({ sort: "default", direction: "asc", columns: [...DEFAULT_ISSUE_COLUMNS] });
    }
    expect(cleanIssueListSearch(parseIssueListSearch({ sort: "bad", direction: "bad", columns: "bad" }))).toEqual({});
    expect(parseIssueListSearch({ q: "検索" })).toEqual({ q: "検索" });
  });
  test("未決事項・PR・見積もり・期限の列は既定で非表示、選ぶとURLに残る（#196）", () => {
    expect(DEFAULT_ISSUE_COLUMNS).toEqual(["priority", "status", "workspace", "project", "assignee"]);
    expect(cleanIssueListSearch({ columns: [...DEFAULT_ISSUE_COLUMNS] })).toEqual({});
    const withDue: IssueListSearch = { columns: [...DEFAULT_ISSUE_COLUMNS, "dueDate"] };
    expect(cleanIssueListSearch(withDue)).toEqual(withDue);
    expect(parseIssueListSearch({ columns: ["dueDate", "estimate", "status"] }).columns).toEqual(["status", "estimate", "dueDate"]);
  });
  test("優先度・Project・担当の列は既定で表示し、列を明示した既存の URL には足さない（#174）", () => {
    expect(ISSUE_COLUMNS).toEqual(["priority", "status", "questions", "workspace", "project", "assignee", "pr", "estimate", "dueDate"]);
    // #174 より前の既定（status・questions・workspace・pr）を明示した URL は、その4列のまま復元する
    const before: IssueListSearch = { columns: ["status", "questions", "workspace", "pr"] };
    expect(parseIssueListSearch({ ...before }).columns).toEqual(before.columns);
    expect(cleanIssueListSearch(before)).toEqual(before);
    expect(parseIssueListSearch({ columns: ["assignee", "pr", "priority", "project"] }).columns).toEqual(["priority", "project", "assignee", "pr"]);
    expect(parseIssueListSearch({}).columns).toBeUndefined();
  });
  test("#196 より前の既定（未決事項・PR を含む7列）を明示した URL は、その列のまま復元して URL に残す", () => {
    const before: IssueListSearch = { columns: ["priority", "status", "questions", "workspace", "project", "assignee", "pr"] };
    expect(parseIssueListSearch({ ...before }).columns).toEqual(before.columns);
    expect(cleanIssueListSearch(before)).toEqual(before);
  });
  test("並び順に見積もりと期限を選べる", () => {
    for (const sort of ["estimate", "dueDate"] as const) {
      expect(parseIssueListSearch({ sort }).sort).toBe(sort);
      expect(cleanIssueListSearch({ sort })).toEqual({ sort });
    }
  });
  test("表示変更だけは履歴を追加する", () => {
    for (const patch of [{ sort: "title" }, { direction: "desc" }, { columns: [] }] as const) expect(replacesIssueListHistory({ ...patch } as never)).toBe(false);
    expect(replacesIssueListHistory({ q: "入力" })).toBe(true);
  });
});

test("archived は真のときだけ残し、知らない値は捨てる", () => {
  for (const value of [true, "true", "1"]) expect(parseIssueListSearch({ archived: value })).toEqual({ archived: true });
  for (const value of [false, "false", "0", "yes"]) expect(parseIssueListSearch({ archived: value })).toEqual({});
  expect(cleanIssueListSearch({ archived: true, tab: "all" })).toEqual({ archived: true });
  expect(cleanIssueListSearch({ archived: false })).toEqual({});
});

describe("担当の絞り込みと My issues（#162）", () => {
  test("assignee は文字列か配列を受け付け、空と重複を除き、none は小文字にそろえる", () => {
    expect(parseIssueListSearch({ assignee: "me" })).toEqual({ assignee: ["me"] });
    expect(parseIssueListSearch({ assignee: ["claude-code", " me ", "", "me", "NONE"] })).toEqual({ assignee: ["claude-code", "me", "none"] });
    expect(parseIssueListSearch({ assignee: [null, {}] })).toEqual({});
    expect(cleanIssueListSearch({ assignee: ["me"], tab: "all" })).toEqual({ assignee: ["me"] });
    expect(cleanIssueListSearch({ assignee: [] })).toEqual({});
  });

  test("assignee はカンマ区切りも分ける（API・CLI と同じ。label は分けない）（#166）", () => {
    expect(parseIssueListSearch({ assignee: "me,codex" })).toEqual({ assignee: ["me", "codex"] });
    expect(parseIssueListSearch({ assignee: ["me, claude-code", "codex,me", " , ", "NONE,x"] })).toEqual({ assignee: ["me", "claude-code", "codex", "none", "x"] });
    expect(parseIssueListSearch({ assignee: "," })).toEqual({});
    expect(parseIssueListSearch({ label: "a,b" })).toEqual({ label: ["a,b"] });
  });

  test("assignee のない既存の URL はそのまま復元する", () => {
    const search = { tab: "delegated", groupBy: "workspace", workspace: ["API"], status: ["todo"], project: "3", cycle: "none", blocked: false } as const;
    expect(cleanIssueListSearch(parseIssueListSearch({ ...search }))).toEqual({ ...search, workspace: ["API"], status: ["todo"] });
  });

  test("My issues の URL はタブと担当の条件を持たない", () => {
    expect(cleanMyIssuesSearch({ tab: "all" })).toEqual({});
    expect(cleanMyIssuesSearch({ tab: "ready" })).toEqual({});
    expect(cleanMyIssuesSearch({ tab: "delegated", workspace: ["API"] })).toEqual({ workspace: ["API"] });
    expect(cleanMyIssuesSearch({ assignee: ["codex"], label: ["bug"] })).toEqual({ label: ["bug"] });
  });

  test("My issues は Status でまとめるのが既定で、明示した「なし」は URL に残す", () => {
    expect(defaultGroupBy(undefined, true)).toBe("status");
    expect(defaultGroupBy("delegated", true)).toBe("status");
    expect(defaultGroupBy("delegated")).toBe("assignee");
    expect(defaultGroupBy(undefined)).toBeUndefined();
    expect(cleanMyIssuesSearch({ groupBy: "none" })).toEqual({ groupBy: "none" });
    expect(cleanMyIssuesSearch({ groupBy: "none", tab: "delegated" })).toEqual({ groupBy: "none" });
    expect(cleanMyIssuesSearch({ subGroupBy: "priority" })).toEqual({ subGroupBy: "priority" });
    expect(cleanMyIssuesSearch({ subGroupBy: "status" })).toEqual({});
    expect(cleanIssueListSearch({ groupBy: "none" })).toEqual({});
  });
});

describe("画面ごとの既定の列（#174）", () => {
  test("Project 詳細は Project を既定から外す。My issues は担当が me と LLM に分かれるため外さない", () => {
    expect(defaultIssueColumns()).toEqual([...DEFAULT_ISSUE_COLUMNS]);
    expect(defaultIssueColumns("project")).toEqual(["priority", "status", "workspace", "assignee"]);
  });

  test("外した列を出したら URL に明示して残し、その画面の既定と同じ列は URL から消す", () => {
    const all = [...DEFAULT_ISSUE_COLUMNS];
    expect(cleanProjectIssuesSearch({ columns: all })).toEqual({ columns: all });
    expect(cleanProjectIssuesSearch({ columns: defaultIssueColumns("project") })).toEqual({});
    expect(cleanMyIssuesSearch({ columns: all })).toEqual({});
    expect(cleanMyIssuesSearch({ columns: defaultIssueColumns("assignee") })).toEqual({ columns: defaultIssueColumns("assignee") });
    // Issues・View・Cycle 詳細は変えない
    expect(cleanIssueListSearch({ columns: all })).toEqual({});
    expect(cleanIssueListSearch({ columns: defaultIssueColumns("project") })).toEqual({ columns: defaultIssueColumns("project") });
  });
});
