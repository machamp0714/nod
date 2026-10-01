import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useFilterOptions, useIssueRows } from "../api/hooks/issues";
import { useCreateView, useViews } from "../api/hooks/views";
import { FilterBar, useFilterChips } from "../components/issue-list/FilterBar";
import { DeletedIssueToast } from "../components/issue-detail/DeletedIssueToast";
import { IssueList } from "../components/issue-list/IssueList";
import { Button } from "../components/ui";
import { ViewDialog } from "../components/views/ViewDialog";
import { filterFromSearch, filterToSearch } from "../lib/issue-filter";
import { describeDisplay, displayFromSearch, unsavedNote } from "../lib/view-display";
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
  // View に保存する内容（#175）。委任中タブは、開いたときも委任中だけが出るように絞り込み条件へ含める。
  // Ready・Needs Clarification のタブ、グループ化、並び順、列などは表示設定として保存する。検索欄の入力とプレビューは保存しない
  const savedFilter = search.tab === "delegated" ? { ...filter, delegated: true } : filter;
  const savedDisplay = displayFromSearch(search);
  const savedChips = useFilterChips(savedFilter, options);
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
      <DeletedIssueToast />
      {saving && (
        <ViewDialog
          title="View として保存"
          submitLabel="保存"
          initial={{ name: "", color: null }}
          views={views.isError ? undefined : views.data}
          selfId={null}
          summary={{ chips: savedChips, display: describeDisplay(savedDisplay), note: unsavedNote(search) }}
          onSubmit={async (value) => {
            const view = await createView.mutateAsync({ ...value, filter: savedFilter, display: savedDisplay });
            setSaving(false);
            navigate({ to: "/views/$viewId", params: { viewId: String(view.id) } });
          }}
          onClose={() => setSaving(false)}
        />
      )}
    </>
  );
}
