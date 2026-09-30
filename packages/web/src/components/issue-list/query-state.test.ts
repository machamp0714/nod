import { expect, test } from "bun:test";
import type { Issue } from "../../api/types";
import { countRows, filterRows, groupRowsByWorkspace } from "./issue-list";
import type { IssueListRow } from "./types";
import { cleanIssueListSearch, parseIssueListSearch } from "../../routes/search";
import { filterFromSearch, filterToSearch, issueQueryToParams, sameFilter, describeFilter } from "../../lib/issue-filter";

const rows: IssueListRow[] = [
  { issue: { id: "API-2", workspace: "API", title: "対象", description: "Users 日本語 ÉCOLE %_", status: "todo", priority: 0 } as Issue, ready: true, questions: {decided:0,total:0}, workspaceName: "同名" },
  { issue: { id: "WEB-1", workspace: "WEB", title: "他", description: null, status: "todo", priority: 0 } as Issue, ready: false, questions: {decided:0,total:0}, workspaceName: "同名" },
];
test("説明検索は非ASCIIの大小文字を維持しカードの母集団は変えない", () => {
  for (const q of ["users", " 日本語 ", "école", "%_"]) expect(filterRows(rows, {tab:"all", q}).map(r => r.issue.id)).toEqual(["API-2"]);
  expect(countRows(rows)).toEqual({all:2,ready:1,needsClarification:0,delegated:0,mine:0});
});
test("Workspaceは名前でなくキーで分け入力を変更しない", () => {
  const reversed = [...rows].reverse();
  expect(groupRowsByWorkspace(reversed).map(g => [g.key,g.name,g.rows.map(r=>r.issue.id)])).toEqual([
    ["API","同名",["API-2"]], ["WEB","同名",["WEB-1"]],
  ]);
  expect(reversed[0]?.issue.id).toBe("WEB-1");
  expect(groupRowsByWorkspace([])).toEqual([]);
});
test("表示グループとblockedのfalseをURL往復で保持する", () => {
  expect(parseIssueListSearch({groupBy:"workspace",blocked:false})).toEqual({groupBy:"workspace",blocked:false});
  expect(cleanIssueListSearch({groupBy:"workspace",blocked:false})).toEqual({groupBy:"workspace",blocked:false});
  expect(cleanIssueListSearch(parseIssueListSearch({groupBy:"bad",blocked:"bad"}))).toEqual({});
  expect(filterFromSearch({groupBy:"workspace",q:"表示検索",blocked:false})).toEqual({blocked:false});
  expect(filterToSearch({blocked:false}).blocked).toBe(false);
});
test("API用qとblockedを変換・比較し解除可能なチップにする", () => {
  expect(issueQueryToParams({q:"日本語 %",blocked:false})).toBe("?q=%E6%97%A5%E6%9C%AC%E8%AA%9E+%25&blocked=false");
  expect(sameFilter({blocked:false},{})).toBe(false);
  expect(sameFilter({q:"one"},{q:"two"})).toBe(false);
  const labels={workspace:(s:string)=>s,project:(s:string)=>s,status:(s:string)=>s};
  expect(describeFilter({q:"users",blocked:false},labels).map(c=>c.key)).toEqual(["q","blocked"]);
});
