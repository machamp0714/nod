import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useFilterOptions, useIssueRows } from "../api/hooks/issues";
import { FilterBar } from "../components/issue-list/FilterBar";
import { IssueList } from "../components/issue-list/IssueList";
import { filterFromSearch, filterToSearch } from "../lib/issue-filter";
import { cleanIssueListSearch, type IssueListSearch } from "../routes/search";
const route = getRouteApi("/issues");

export function IssuesPage() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/issues" });
  const filter = filterFromSearch(search);
  const rows = useIssueRows(filter);
  const options = useFilterOptions();
  const change = (patch: IssueListSearch) =>
    navigate({ search: (prev) => cleanIssueListSearch({ ...prev, ...patch }), replace: true });
  return (
    <IssueList
      crumb="All workspaces"
      title="Issues"
      filterBar={<FilterBar filter={filter} options={options} onChange={(next) => change(filterToSearch(next))} />}
      rows={rows.rows}
      loading={rows.loading}
      error={rows.error}
      search={search}
      onSearchChange={change}
    />
  );
}
