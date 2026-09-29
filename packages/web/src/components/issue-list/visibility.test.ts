import { expect, test } from "bun:test";
import type { Issue } from "../../api/types";
import { filterRows, groupForBoard, groupRowsByWorkspace } from "./issue-list";
import type { IssueListRow } from "./types";
import { cleanIssueListSearch, parseIssueListSearch, replacesIssueListHistory } from "../../routes/search";
import { filterFromSearch } from "../../lib/issue-filter";

const rows = [
  ["API-1", "todo", null], ["API-2", "done", null],
  ["API-3", "todo", "OTHER-1"], ["API-4", "done", "API-1"],
  ["API-5", "canceled", null],
].map(([id, status, parentId]) => ({ issue: { id, title: id, workspace: "API", status, parentId } as Issue, ready: id === "API-3", questions: { decided: 0, total: 0 }, workspaceName: "API" } satisfies IssueListRow));
const ids = (value: IssueListRow[]) => value.map((row) => row.issue.id);

test("既定は全件、完了と子Issueを独立して隠し、Canceledは完了扱いしない", () => {
  const filter = { tab: "all" as const, q: "" };
  expect(ids(filterRows(rows, filter))).toEqual(ids(rows));
  expect(ids(filterRows(rows, { ...filter, showCompleted: false }))).toEqual(["API-1", "API-3", "API-5"]);
  expect(ids(filterRows(rows, { ...filter, showChildren: false }))).toEqual(["API-1", "API-2", "API-5"]);
  const visible = filterRows(rows, { ...filter, showCompleted: false, showChildren: false });
  expect(ids(visible)).toEqual(["API-1", "API-5"]);
  expect(ids(groupRowsByWorkspace(visible)[0]!.rows)).toEqual(ids(visible));
  expect(groupForBoard(visible).flatMap((column) => ids(column.rows))).toEqual(["API-1"]);
  expect(ids(rows)).toHaveLength(5);
});

test("APIで絞った母集団・タブ・検索にANDで適用し、親の取得有無に依存しない", () => {
  expect(filterRows(rows.filter((row) => row.issue.status === "done"), { tab: "all", q: "", showCompleted: false })).toEqual([]);
  expect(filterRows(rows, { tab: "ready", q: "", showChildren: false })).toEqual([]);
  expect(filterRows(rows, { tab: "all", q: "API-3", showChildren: false })).toEqual([]);
});

test("表示切替のfalseをURL往復で保持し、不正値は既定へ戻す", () => {
  const search = { showCompleted: false, showChildren: false };
  expect(cleanIssueListSearch(parseIssueListSearch(search))).toEqual(search);
  expect(parseIssueListSearch({ showCompleted: "false", showChildren: "false" })).toEqual(search);
  for (const value of [true, "true", "bad", [], {}, null, 0]) {
    expect(cleanIssueListSearch(parseIssueListSearch({ showCompleted: value, showChildren: value }))).toEqual({});
  }
  expect(replacesIssueListHistory({ showCompleted: false })).toBe(false);
  expect(replacesIssueListHistory({ showChildren: true })).toBe(false);
  expect(filterFromSearch({ ...search, status: ["done"] })).toEqual({ status: ["done"] });
});
