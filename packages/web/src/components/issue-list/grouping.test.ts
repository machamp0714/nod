import { describe, expect, test } from "bun:test";
import type { Issue, Status } from "../../api/types";
import { cleanIssueListSearch, parseIssueListSearch } from "../../routes/search";
import { filterFromSearch } from "../../lib/issue-filter";
import { effectiveGrouping, groupRows } from "./issue-list";
import type { IssueListRow } from "./types";

function row(id: string, opts: Partial<Issue> = {}): IssueListRow {
  return {
    issue: { id, title: id, workspace: id.split("-")[0], status: "todo" as Status, priority: 0, assignee: null, project: null, labels: [], ...opts } as Issue,
    questions: { decided: 0, total: 0 },
    ready: false,
    workspaceName: `${id.split("-")[0]} name`,
  };
}
const shape = (groups: ReturnType<typeof groupRows>) => groups.map((g) => [g.key, g.label, g.rows.map((r) => r.issue.id)]);

describe("groupRows", () => {
  test("Statusは表示順で、表示中のIssueがないStatusは出さない", () => {
    const rows = [row("A-1", { status: "done" }), row("A-2", { status: "triage" }), row("A-3", { status: "done" })];
    expect(shape(groupRows(rows, "status"))).toEqual([["triage", "Triage", ["A-2"]], ["done", "Done", ["A-1", "A-3"]]]);
  });

  test("優先度はUrgent→Low、No priorityを最後にする", () => {
    const rows = [row("A-1", { priority: 0 }), row("A-2", { priority: 4 }), row("A-3", { priority: 1 }), row("A-4", { priority: 2 })];
    expect(shape(groupRows(rows, "priority"))).toEqual([
      ["1", "Urgent", ["A-3"]], ["2", "High", ["A-4"]], ["4", "Low", ["A-2"]], ["0", "No priority", ["A-1"]],
    ]);
  });

  test("Projectは名前順で、Projectなしを最後にする", () => {
    const rows = [row("A-1"), row("A-2", { project: { id: 2, name: "検索" } }), row("A-3", { project: { id: 1, name: "決済" } })];
    expect(shape(groupRows(rows, "project"))).toEqual([["1", "決済", ["A-3"]], ["2", "検索", ["A-2"]], ["", "Projectなし", ["A-1"]]]);
  });

  test("担当は名前順で、未割り当てを最後にする", () => {
    const rows = [row("A-1"), row("A-2", { assignee: "codex" }), row("A-3", { assignee: "claude" })];
    expect(shape(groupRows(rows, "assignee"))).toEqual([["claude", "claude", ["A-3"]], ["codex", "codex", ["A-2"]], ["", "未割り当て", ["A-1"]]]);
  });

  test("複数ラベルのIssueは各ラベルに重複して入り、ラベルなしは最後", () => {
    const rows = [row("A-1", { labels: ["bug", "perf"] }), row("A-2"), row("A-3", { labels: ["perf"] })];
    expect(shape(groupRows(rows, "label"))).toEqual([["bug", "bug", ["A-1"]], ["perf", "perf", ["A-1", "A-3"]], ["", "ラベルなし", ["A-2"]]]);
  });

  test("Workspaceはキー順で名前を持ち、グループ内の並び順と入力を変えない", () => {
    const rows = [row("WEB-2"), row("API-9"), row("WEB-1")];
    const groups = groupRows(rows, "workspace");
    expect(shape(groups)).toEqual([["API", "API", ["API-9"]], ["WEB", "WEB", ["WEB-2", "WEB-1"]]]);
    expect(groups[0]?.workspaceName).toBe("API name");
    expect(rows.map((r) => r.issue.id)).toEqual(["WEB-2", "API-9", "WEB-1"]);
    expect(groupRows([], "workspace")).toEqual([]);
  });

  test("サブグループは各グループ内をさらに分け、件数は各グループの行数", () => {
    const rows = [row("A-1", { status: "done", priority: 1 }), row("A-2", { status: "todo", priority: 1 }), row("A-3", { status: "todo", priority: 0 })];
    const groups = groupRows(rows, "status", "priority");
    expect(groups.map((g) => [g.key, g.rows.length, g.subgroups?.map((sg) => [sg.key, sg.rows.map((r) => r.issue.id)])])).toEqual([
      ["todo", 2, [["1", ["A-2"]], ["0", ["A-3"]]]],
      ["done", 1, [["1", ["A-1"]]]],
    ]);
    expect(groupRows(rows, "status")[0]?.subgroups).toBeUndefined();
  });
});

describe("effectiveGrouping", () => {
  test("BoardではStatusのグループ化とサブグループを無効にする", () => {
    expect(effectiveGrouping({ groupBy: "status", subGroupBy: "priority" }, "board")).toEqual({});
    expect(effectiveGrouping({ groupBy: "priority", subGroupBy: "label" }, "board")).toEqual({ groupBy: "priority" });
    expect(effectiveGrouping({ groupBy: "priority", subGroupBy: "label" }, "list")).toEqual({ groupBy: "priority", subGroupBy: "label" });
    expect(effectiveGrouping({ groupBy: "none", subGroupBy: "label" }, "list")).toEqual({});
    expect(effectiveGrouping({ groupBy: "label", subGroupBy: "label" }, "list")).toEqual({ groupBy: "label" });
  });
});

describe("URL", () => {
  test("グループ化とサブグループをURL往復で保持し、不正値と重複は捨てる", () => {
    for (const groupBy of ["workspace", "status", "priority", "project", "assignee", "label"] as const) {
      expect(cleanIssueListSearch(parseIssueListSearch({ groupBy }))).toEqual({ groupBy });
    }
    expect(cleanIssueListSearch(parseIssueListSearch({ groupBy: "status", subGroupBy: "label" }))).toEqual({ groupBy: "status", subGroupBy: "label" });
    expect(cleanIssueListSearch(parseIssueListSearch({ groupBy: "status", subGroupBy: "status" }))).toEqual({ groupBy: "status" });
    expect(cleanIssueListSearch(parseIssueListSearch({ subGroupBy: "label" }))).toEqual({});
    expect(cleanIssueListSearch(parseIssueListSearch({ groupBy: "bad", subGroupBy: "bad" }))).toEqual({});
  });

  test("グループ化はViewの条件に入らない", () => {
    expect(filterFromSearch({ groupBy: "label", subGroupBy: "status", label: ["bug"] })).toEqual({ label: ["bug"] });
  });
});
