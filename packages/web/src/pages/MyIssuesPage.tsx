import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useFilterOptions, useIssueRows } from "../api/hooks/issues";
import { FilterBar } from "../components/issue-list/FilterBar";
import { IssueList } from "../components/issue-list/IssueList";
import { filterFromSearch, filterToSearch, withoutKey } from "../lib/issue-filter";
import { cleanMyIssuesSearch, replacesIssueListHistory, type IssueListSearch } from "../routes/search";

const route = getRouteApi("/my-issues");

// Pencil「My issues（#162）」：全 Workspace の Issue を「担当（担当が me）｜委任中（担当が LLM で未完了）」のタブで出す。
// 担当の条件は固定で、URL の assignee は使わない。ほかの条件（Workspace・Status・Project など）は Issues と同じく絞り込める
export function MyIssuesPage() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/my-issues" });
  const filter = withoutKey(filterFromSearch(search), "assignee");
  const rows = useIssueRows(filter);
  const options = useFilterOptions();
  const change = (patch: IssueListSearch) =>
    navigate({ search: (prev) => cleanMyIssuesSearch({ ...prev, ...patch }), replace: replacesIssueListHistory(patch) });
  return (
    <IssueList
      mine
      crumb="All workspaces"
      title="My issues"
      rows={rows.rows}
      loading={rows.loading}
      error={rows.error}
      search={search}
      onSearchChange={change}
      filterBar={<FilterBar filter={filter} options={options} fixedAssignee="me" onChange={(next) => change(filterToSearch(next))} />}
    />
  );
}
