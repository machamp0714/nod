import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useFilterOptions, useIssueRows } from "../api/hooks/issues";
import { useCreateView, useViews } from "../api/hooks/views";
import { FilterBar } from "../components/issue-list/FilterBar";
import { IssueList } from "../components/issue-list/IssueList";
import { Button } from "../components/ui";
import { ViewDialog } from "../components/views/ViewDialog";
import { filterFromSearch, filterToSearch } from "../lib/issue-filter";
import { replacesIssueListHistory, cleanIssueListSearch, type IssueListSearch } from "../routes/search";

const route = getRouteApi("/issues");

export function IssuesPage() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/issues" });
  const filter = filterFromSearch(search);
  const rows = useIssueRows(filter);
  const options = useFilterOptions();
  const views = useViews();
  const createView = useCreateView();
  const [saving, setSaving] = useState(false);
  const change = (patch: IssueListSearch) =>
    navigate({ search: (prev) => cleanIssueListSearch({ ...prev, ...patch }), replace: replacesIssueListHistory(patch) });
  return (
    <>
      <IssueList
        crumb="All workspaces"
        title="Issues"
        rows={rows.rows}
        loading={rows.loading}
        error={rows.error}
        search={search}
        onSearchChange={change}
        actions={
          <Button variant="soft" icon="layers" disabled={!views.data || views.isError} onClick={() => setSaving(true)}>
            View として保存
          </Button>
        }
        filterBar={<FilterBar filter={filter} options={options} onChange={(next) => change(filterToSearch(next))} />}
      />
      {saving && (
        <ViewDialog
          title="View として保存"
          submitLabel="保存"
          initial={{ name: "", color: null }}
          views={views.isError ? undefined : views.data}
          selfId={null}
          onSubmit={async (value) => {
            // 委任中タブで保存した View は、開いたときも委任中だけが出るように条件へ含める（Ready タブは含めない）
            const saved = search.tab === "delegated" ? { ...filter, delegated: true } : filter;
            const view = await createView.mutateAsync({ ...value, filter: saved });
            setSaving(false);
            navigate({ to: "/views/$viewId", params: { viewId: String(view.id) } });
          }}
          onClose={() => setSaving(false)}
        />
      )}
    </>
  );
}
