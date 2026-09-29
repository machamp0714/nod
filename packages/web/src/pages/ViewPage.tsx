import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useFilterOptions, useIssueRows } from "../api/hooks/issues";
import { useDeleteView, useUpdateView, useViews } from "../api/hooks/views";
import type { IssueQuery, View } from "../api/types";
import { FilterBar } from "../components/issue-list/FilterBar";
import { IssueList } from "../components/issue-list/IssueList";
import { Button, PageError, PageLoading, Pill } from "../components/ui";
import { ViewDialog } from "../components/views/ViewDialog";
import { errorMessage } from "../api/errors";
import { sameFilter } from "../lib/issue-filter";
import { replacesIssueListHistory, cleanIssueListSearch } from "../routes/search";
import { NotFoundMessage } from "./NotFoundPage";

const route = getRouteApi("/views/$viewId");

export function ViewPage() {
  const { viewId } = route.useParams();
  const views = useViews();
  if (views.error) return <PageError message={errorMessage(views.error)} />;
  if (!views.data) return <PageLoading />;
  // GET /api/views/:id の 404 をコンソールに出さないため、一覧から探す
  const view = views.data.find((v) => String(v.id) === viewId);
  if (!view) return <NotFoundMessage title="View が見つかりません" />;
  // 別の View に移ったときと、保存した条件が変わったときに、保存していない条件を捨てて開き直す
  return <ViewIssues key={`${view.id}:${JSON.stringify(view.filter)}`} view={view} views={views.data} />;
}

function ViewIssues({ view, views }: { view: View; views: View[] }) {
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/views/$viewId" });
  const [draft, setDraft] = useState<IssueQuery>(view.filter);
  const [renaming, setRenaming] = useState(false);
  const rows = useIssueRows(draft);
  const options = useFilterOptions();
  const saveFilter = useUpdateView();
  const rename = useUpdateView();
  const remove = useDeleteView();
  const dirty = !sameFilter(draft, view.filter);

  async function deleteView() {
    if (!window.confirm(`View「${view.name}」を削除しますか？`)) return;
    try {
      // 再取得でこの View がアンマウントされても、削除後の遷移を完了する。
      await remove.mutateAsync(view.id);
      await navigate({ to: "/issues" });
    } catch {
      // mutation のエラー表示から再試行できる。イベント処理の Promise は拒否しない。
    }
  }

  return (
    <>
      <IssueList
        crumb="Views"
        title={view.name}
        rows={rows.rows}
        loading={rows.loading}
        error={rows.error}
        search={search}
        onSearchChange={(patch) => navigate({ search: (prev) => cleanIssueListSearch({ ...prev, ...patch }), replace: replacesIssueListHistory(patch) })}
        actions={
          <>
            {saveFilter.isError && <Pill tone="fail">保存できませんでした</Pill>}
            {remove.isError && <span role="alert"><Pill tone="fail">削除できませんでした：{errorMessage(remove.error)}</Pill></span>}
            {dirty && <Button onClick={() => setDraft(view.filter)}>元に戻す</Button>}
            {dirty && (
              <Button
                variant="primary"
                icon="layers"
                disabled={saveFilter.isPending}
                onClick={() => saveFilter.mutate({ id: view.id, input: { filter: draft } })}
              >
                変更を保存
              </Button>
            )}
            <Button icon="square-pen" onClick={() => setRenaming(true)}>
              名前を変更
            </Button>
            <Button variant="danger" icon="trash-2" disabled={remove.isPending} onClick={() => void deleteView()}>
              削除
            </Button>
          </>
        }
        filterBar={<FilterBar filter={draft} options={options} onChange={setDraft} />}
      />
      {renaming && (
        <ViewDialog
          title="View の名前を変更"
          submitLabel="保存"
          initial={{ name: view.name, color: view.color }}
          views={views}
          selfId={view.id}
          onSubmit={async (value) => {
            await rename.mutateAsync({ id: view.id, input: value });
            setRenaming(false);
          }}
          onClose={() => setRenaming(false)}
        />
      )}
    </>
  );
}
