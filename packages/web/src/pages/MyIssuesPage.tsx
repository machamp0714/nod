import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { usePageDisplay } from "../api/hooks/page-displays";
import { useFilterOptions, useIssueRows } from "../api/hooks/issues";
import { FilterBar } from "../components/issue-list/FilterBar";
import { IssueList } from "../components/issue-list/IssueList";
import { PageLoading } from "../components/ui";
import { filterFromSearch, filterToSearch, withoutKey } from "../lib/issue-filter";
import { withoutPageDisplay } from "../lib/page-display";
import { cleanMyIssuesSearch, replacesIssueListHistory, type IssueListSearch } from "../routes/search";

const route = getRouteApi("/my-issues");

// Pencil「My issues（#162）」：全 Workspace の Issue を「担当（担当が me）｜委任中（担当が LLM で未完了）」のタブで出す。
// 担当の条件は固定で、URL の assignee は使わない。ほかの条件（Workspace・Status・Project など）は Issues と同じく絞り込める。
// 固定チップはタブの条件に合わせ、担当タブは「担当 is me」、委任中タブは「担当 is LLM」（行の担当は LLM のため）
export function MyIssuesPage() {
  const url = route.useSearch();
  const navigate = useNavigate({ from: "/my-issues" });
  const page = usePageDisplay({ key: "my-issues", mine: true }, url);
  const search = page.search;
  const filter = withoutKey(filterFromSearch(search), "assignee");
  const rows = useIssueRows(filter);
  const options = useFilterOptions();
  const change = (patch: IssueListSearch) => {
    page.save(patch);
    navigate({ search: (prev) => cleanMyIssuesSearch({ ...prev, ...patch }), replace: replacesIssueListHistory(patch) });
  };
  const resetDisplay = () => {
    page.reset();
    navigate({ search: (prev) => withoutPageDisplay(prev), replace: true });
  };
  if (!page.ready) return <PageLoading />;
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
      onResetDisplay={resetDisplay}
      resetDisplayDisabled={page.resetDisabled}
      filterBar={<FilterBar filter={filter} options={options} fixedAssignee={search.tab === "delegated" ? "LLM" : "me"} onChange={(next) => change(filterToSearch(next))} />}
    />
  );
}
