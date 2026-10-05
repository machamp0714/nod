import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { errorMessage } from "../api/errors";
import { useCycle, useCycles } from "../api/hooks/cycles";
import { usePageDisplay } from "../api/hooks/page-displays";
import { useIssueRows } from "../api/hooks/issues";
import type { CycleDetail } from "../api/types";
import { IssueList } from "../components/issue-list/IssueList";
import { PageError, PageLoading, ProgressBar } from "../components/ui";
import { formatCyclePeriod } from "../lib/cycles";
import { withoutPageDisplay } from "../lib/page-display";
import { cleanIssueListSearch, replacesIssueListHistory } from "../routes/search";
import { CycleStateBadge } from "./CyclesPage";
import { NotFoundMessage } from "./NotFoundPage";
import s from "./cycle-detail.module.css";

const route = getRouteApi("/cycles/$cycleId");

// Pencil「Cycle詳細（#82）」。概要（期間・進捗・未完了）と、Cycle の Issue 一覧
export function CycleDetailPage() {
  const { cycleId } = route.useParams();
  const url = route.useSearch();
  const navigate = useNavigate({ from: "/cycles/$cycleId" });
  const cycles = useCycles();
  const found = cycles.data?.some((c) => String(c.id) === cycleId) ?? false;
  const detail = useCycle(Number(cycleId), found);
  // 保存した表示設定（#218）と URL を合わせた状態
  const page = usePageDisplay({ key: `cycle:${cycleId}` }, url);
  const search = page.search;
  const rows = useIssueRows({ cycle: cycleId }, found);

  if (cycles.error) return <PageError message={errorMessage(cycles.error)} />;
  if (!cycles.data) return <PageLoading />;
  if (!found) return <NotFoundMessage title="Cycle が見つかりません" />;
  if (detail.error) return <PageError message={errorMessage(detail.error)} />;
  if (!detail.data) return <PageLoading />;
  if (!page.ready) return <PageLoading />;
  const cycle = detail.data;
  return (
    <IssueList
      crumb={<Link to="/cycles">Cycles</Link>}
      title={cycle.name}
      actions={<CycleStateBadge state={cycle.state} />}
      intro={<CycleOverview key={cycle.id} cycle={cycle} />}
      rows={rows.rows}
      loading={rows.loading}
      error={rows.error}
      search={search}
      onSearchChange={(patch) => {
        page.save(patch);
        navigate({ search: (prev) => cleanIssueListSearch({ ...prev, ...patch }), replace: replacesIssueListHistory(patch) });
      }}
      onResetDisplay={() => {
        page.reset();
        navigate({ search: (prev) => withoutPageDisplay(prev), replace: true });
      }}
      resetDisplayDisabled={page.resetDisabled}
    />
  );
}

function CycleOverview({ cycle }: { cycle: CycleDetail }) {
  return (
    <section className={s.overview} aria-label="Cycle の概要">
      <span className={s.field}>
        <span className={s.label}>期間</span>
        <span>{formatCyclePeriod(cycle)}</span>
      </span>
      <span className={s.field}>
        <span className={s.label}>進捗</span>
        <ProgressBar value={cycle.done} max={cycle.total} />
        <span className={s.count}>
          {cycle.done}/{cycle.total}
        </span>
        <span className={s.open}>未完了 {cycle.open}</span>
      </span>
    </section>
  );
}
