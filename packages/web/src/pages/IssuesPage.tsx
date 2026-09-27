import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { IssueList } from "../components/issue-list/IssueList";
import { ISSUE_ROWS } from "../fixtures/issue-rows";
import { cleanIssueListSearch } from "../routes/search";

const route = getRouteApi("/issues");

export function IssuesPage() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/issues" });
  return (
    <IssueList
      crumb="All workspaces"
      title="Issues"
      rows={ISSUE_ROWS}
      search={search}
      onSearchChange={(patch) => navigate({ search: (prev) => cleanIssueListSearch({ ...prev, ...patch }), replace: true })}
    />
  );
}
