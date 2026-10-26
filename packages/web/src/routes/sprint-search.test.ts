import { expect, test } from "bun:test";
import { cleanIssueListSearch, parseIssueListSearch, parseProjectsSearch, cleanProjectsSearch } from "./search";
import { filterFromSearch, filterToSearch, issueQueryToParams, sameFilter } from "../lib/issue-filter";
import { displayFromSearch, viewSearch } from "../lib/view-display";

test("相対currentをURL・Filter・保存Viewの往復で固定参照へ変えず保持する", () => {
  const search = parseIssueListSearch({ sprint: "current", groupBy: "sprint", columns: ["status", "workspace", "sprint"] });
  expect(search).toEqual({ sprint: "current", groupBy: "sprint", columns: ["status", "workspace", "sprint"] });
  const filter = filterFromSearch(search);
  expect(filter).toEqual({ sprint: "current" });
  expect(issueQueryToParams(filter)).toBe("?sprint=current");
  expect(cleanIssueListSearch(filterToSearch(filter))).toEqual({ sprint: "current" });
  expect(sameFilter(filter, {})).toBe(false);
  const display = displayFromSearch(search);
  expect(viewSearch(display, {})).toEqual({ groupBy: "sprint", columns: ["status", "workspace", "sprint"] });
});

test("Workspace配下のProjectsリンクの範囲をURL往復で維持する", () => {
  expect(cleanProjectsSearch(parseProjectsSearch({ workspace: "nod", tab: "completed" }))).toEqual({ workspace: "NOD", tab: "completed" });
});

test("固定参照・none・未解決条件を黙って外さずAPIまで渡す", () => {
  for (const sprint of ["a922eb61-2e54-4700-af51-b6b415ae5320", "42", "none", "unresolved:cycle:99", "失われた期間"]) {
    const query = filterFromSearch(parseIssueListSearch({ sprint }));
    expect(query).toEqual({ sprint });
    expect(new URLSearchParams(issueQueryToParams(query)).get("sprint")).toBe(sprint);
  }
});
