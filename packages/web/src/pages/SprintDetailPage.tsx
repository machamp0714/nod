import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { useSprint, useSprints } from "../api/hooks/sprints";
import { usePageDisplay } from "../api/hooks/page-displays";
import { useIssueRows } from "../api/hooks/issues";
import { SprintAnalyticsPanel } from "../components/cycles/SprintAnalyticsPanel";
import { IssueList } from "../components/issue-list/IssueList";
import { Button, IconButton, PageError, PageLoading, ProgressBar } from "../components/ui";
import { SPRINT_PHASE_LABEL, sprintSnapshotRows } from "../lib/sprints";
import { withoutPageDisplay } from "../lib/page-display";
import { cleanIssueListSearch, replacesIssueListHistory } from "../routes/search";
import { NotFoundMessage } from "./NotFoundPage";
import s from "./cycle-detail.module.css";

const route = getRouteApi("/sprints/$sprintId");

export function SprintDetailPage() {
  const { sprintId } = route.useParams();
  const url = route.useSearch();
  const navigate = useNavigate({ from: "/sprints/$sprintId" });
  const sprints = useSprints();
  const found = sprints.data?.find((item) => item.id === sprintId || String(item.number) === sprintId);
  const detail = useSprint(sprintId, !!found);
  const page = usePageDisplay({ key: `sprint:${found?.id ?? sprintId}` }, url);
  const rows = useIssueRows({ sprint: sprintId }, !!detail.data && detail.data.phase !== "imported");
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const analyticsButton = useRef<HTMLButtonElement>(null);
  const closeAnalytics = useCallback(() => { setAnalyticsOpen(false); analyticsButton.current?.focus(); }, []);
  useEffect(() => {
    if (!analyticsOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if ((event.target as HTMLElement | null)?.closest("input, textarea, select, dialog, [role=dialog], [role=menu]")) return;
      event.preventDefault(); closeAnalytics();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [analyticsOpen, closeAnalytics]);
  const error = sprints.error ?? detail.error;
  if (error) return <><PageError message={errorMessage(error)} /><Button onClick={() => { void sprints.refetch(); void detail.refetch(); }}>再試行</Button></>;
  if (!sprints.data) return <PageLoading />;
  if (!found) return <NotFoundMessage title="Sprint が見つかりません" />;
  if (!detail.data || !page.ready) return <PageLoading />;
  const sprint = detail.data;
  const imported = sprint.phase === "imported";
  const snapshots = imported ? sprintSnapshotRows(sprint) : [];
  const shownRows = imported ? snapshots : rows.rows;
  const countsKnown = imported || (!rows.loading && !rows.error);
  const completed = shownRows.filter((item) => item.issue.status === "done").length;
  return <div className={s.layout}>
    <IssueList crumb={<Link to="/sprints">Sprints</Link>} title={sprint.name}
      titleNote={<span>{SPRINT_PHASE_LABEL[sprint.phase]}</span>}
      actions={<IconButton ref={analyticsButton} icon="chart-line" label="分析" bordered aria-pressed={analyticsOpen} className={analyticsOpen ? s.pressed : undefined}
        onClick={() => analyticsOpen ? closeAnalytics() : setAnalyticsOpen(true)} />}
      intro={<>
        <section className={s.overview} aria-label="Sprint の概要">
          <span className={s.field}><span className={s.label}>期間</span>{sprint.startDate} – {sprint.endDate}</span>
          <span className={s.field}><span className={s.label}>{imported ? "移行時の完了" : "タスク完了"}</span>
            {countsKnown ? <><ProgressBar value={completed} max={shownRows.length} /><span className={s.count}>{completed}/{shownRows.length}</span><span className={s.open}>未完了 {shownRows.length - completed}</span></> : <span>{rows.error ? "不明" : "読み込み中…"}</span>}
          </span>
          <span className={s.field}><span className={s.label}>timezone</span>{sprint.timezone ?? "不明"}</span>
          <span className={s.field}><span className={s.label}>Sprint番号</span>{sprint.number}</span>
          {imported && <span>旧Cycle ID: {sprint.legacyCycleId ?? "不明"}</span>}
        </section>
        <section className={s.evidence} aria-label="Sprint の記録">
          <p>ゴール: {sprint.goal ?? "不明"} / DoD: {sprint.definitionOfDone ?? "不明"}</p>
          <p>合意: {sprint.adoptedPlanId ? "採用計画あり" : "不明"} / 達成結果: {sprint.outcome ?? "不明"}</p>
          {imported && <><p>移行時の状態（{sprint.legacy?.capturedAt ?? "取得時点不明"}）。元のWorkspaceとともに表示します。</p><p>終了時点の成果は不明</p></>}
        </section>
      </>}
      rows={shownRows} loading={!imported && rows.loading} error={!imported ? rows.error : null}
      onRetry={rows.retry} readOnly={imported} search={page.search}
      onSearchChange={(patch) => { page.save(patch); void navigate({ search: (prev) => cleanIssueListSearch({ ...prev, ...patch }), replace: replacesIssueListHistory(patch) }); }}
      onResetDisplay={() => { page.reset(); void navigate({ search: (prev) => withoutPageDisplay(prev), replace: true }); }} resetDisplayDisabled={page.resetDisabled}
      afterContent={imported && <section className={s.evidence} aria-label="履歴の根拠">
        <details><summary>取得済みの履歴と元イベント（{sprint.events.length}件）</summary>
          {sprint.events.map((event) => <div key={event.original.id}>
            <p>元イベント #{event.original.id} / 元Issue ID {event.original.issue_id} / {event.original.actor} / {event.original.created_at} / {event.association === "ambiguous" ? "関連未確定（旧ID再利用の可能性）" : "取得済みの関連"}</p>
            <pre>{event.original.type}: {event.original.data}</pre>
          </div>)}
          {sprint.events.length === 0 && <p>履歴は未記録です</p>}
        </details>
        <details><summary>元Issue・Workspaceの保存記録（{sprint.evidence.length}件）</summary>
          {sprint.evidence.map((item) => <p key={item.sourceIssueId}>{item.sourceIssueKey} / 元Issue ID {item.sourceIssueId} / {item.snapshot.workspace.name}（{item.snapshot.workspace.key}）/ {item.snapshot.capturedAt}</p>)}
        </details>
      </section>}
    />
    {analyticsOpen && <SprintAnalyticsPanel key={sprint.id} cycle={sprint} onClose={closeAnalytics} />}
  </div>;
}
