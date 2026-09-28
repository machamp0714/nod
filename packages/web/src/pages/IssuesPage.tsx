import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useIssueRows } from "../api/hooks/issues";
import { IssueList } from "../components/issue-list/IssueList";
import { filterFromSearch } from "../lib/issue-filter";
import { cleanIssueListSearch, type IssueListSearch } from "../routes/search";

const route = getRouteApi("/issues");

export function IssuesPage() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/issues" });
  const rows = useIssueRows(filterFromSearch(search));
  const change = (patch: IssueListSearch) =>
    navigate({ search: (prev) => cleanIssueListSearch({ ...prev, ...patch }), replace: true });
  return (
    <IssueList
      crumb="All workspaces"
      title="Issues"
      rows={rows.rows}
      loading={rows.loading}
      error={rows.error}
      search={search}
      onSearchChange={change}
    />
  );
}
