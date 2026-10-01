import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { singleWorkspace } from "../lib/workspace-labels";
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
import { cleanViewSearch, displayFromSearch, sameDisplay, savedDisplay, viewSearch, withoutDisplay } from "../lib/view-display";
import { replacesIssueListHistory } from "../routes/search";
import { NotFoundMessage } from "./NotFoundPage";
import s from "./view.module.css";

const route = getRouteApi("/views/$viewId");

export function ViewPage() {
  const { viewId } = route.useParams();
  const views = useViews();
  if (views.error) return <PageError message={errorMessage(views.error)} />;
  if (!views.data) return <PageLoading />;
  // GET /api/views/:id の 404 をコンソールに出さないため、一覧から探す
  const view = views.data.find((v) => String(v.id) === viewId);
  if (!view) return <NotFoundMessage title="View が見つかりません" />;
  // 別の View に移ったときと、保存した条件・表示設定が変わったときに、保存していない条件を捨てて開き直す
  return <ViewIssues key={`${view.id}:${JSON.stringify(view.filter)}:${JSON.stringify(view.display)}`} view={view} views={views.data} />;
}

function ViewIssues({ view, views }: { view: View; views: View[] }) {
  // URL に明示した表示設定は URL を優先し、ないものは View に保存した表示設定で表示する（#175）
  const search = viewSearch(view.display, route.useSearch());
  const navigate = useNavigate({ from: "/views/$viewId" });
  const [draft, setDraft] = useState<IssueQuery>(view.filter);
  const [renaming, setRenaming] = useState(false);
  const rows = useIssueRows(draft);
  const options = useFilterOptions();
  const saveFilter = useUpdateView();
  const rename = useUpdateView();
  const remove = useDeleteView();
  // 委任中タブは表示設定ではなく絞り込み条件（delegated）として保存する（Issues の「View として保存」と同じ）
  const nextFilter = search.tab === "delegated" ? { ...draft, delegated: true } : draft;
  const nextDisplay = displayFromSearch(search);
  const dirty = !sameFilter(nextFilter, view.filter) || !sameDisplay(nextDisplay, savedDisplay(view.display));

  // 表示設定のクエリを URL から外すと、View に保存した表示設定に戻る。絞り込みの下書きも一緒に戻す
  async function revert() {
    setDraft(view.filter);
    await navigate({ search: (prev) => withoutDisplay(prev), replace: true });
  }

  async function save() {
    try {
      await saveFilter.mutateAsync({ id: view.id, input: { filter: nextFilter, display: nextDisplay } });
      // 保存した表示設定は View が持つため、URL からは外す
      await navigate({ search: (prev) => withoutDisplay(prev), replace: true });
    } catch {
      // 失敗は saveFilter.isError で表示する。イベント処理の Promise は拒否しない。
    }
  }

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
        titleIcon={
          <span className={s.titleSwatchBox} aria-hidden="true">
            <span className={s.titleSwatch} style={{ background: view.color ?? undefined }} />
          </span>
        }
        titleNote={dirty && <span className={s.dirtyBox}><span className={s.dirty}>変更あり</span></span>}
        rows={rows.rows}
        loading={rows.loading}
        error={rows.error}
        search={search}
        statusWorkspace={singleWorkspace(draft.workspace)}
        onSearchChange={(patch) => navigate({ search: (prev) => cleanViewSearch({ ...viewSearch(view.display, prev), ...patch }, view.display), replace: replacesIssueListHistory(patch) })}
        // 失敗の表示は Header（高さ 44 で折り返さない）の外に出す
        intro={
          (saveFilter.isError || remove.isError) && (
            <div>
              {saveFilter.isError && <Pill tone="fail">保存できませんでした</Pill>}
              {remove.isError && <span role="alert"><Pill tone="fail">削除できませんでした：{errorMessage(remove.error)}</Pill></span>}
            </div>
          )
        }
        actions={
          <>
            {dirty && <Button onClick={() => void revert()}>元に戻す</Button>}
            {dirty && (
              <Button
                variant="primary"
                icon="layers"
                disabled={saveFilter.isPending}
                onClick={() => void save()}
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
