import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { errorMessage } from "../api/errors";
import { useCycle, useCycles, useMoveOpenIssues } from "../api/hooks/cycles";
import { useIssueRows } from "../api/hooks/issues";
import type { CycleDetail, CycleSummary } from "../api/types";
import { IssueList } from "../components/issue-list/IssueList";
import { FormDialog } from "../components/planning/FormDialog";
import d from "../components/planning/planning.module.css";
import { Button, Icon, PageError, PageLoading, ProgressBar } from "../components/ui";
import { CYCLE_STATE_LABEL, defaultDestination, formatCyclePeriod } from "../lib/cycles";
import { cleanIssueListSearch, replacesIssueListHistory } from "../routes/search";
import { CycleStateBadge } from "./CyclesPage";
import { NotFoundMessage } from "./NotFoundPage";
import s from "./cycle-detail.module.css";

const route = getRouteApi("/cycles/$cycleId");

// Pencil「Cycle詳細（#82）」。概要（期間・進捗・未完了）と、未完了を別の Cycle へ移す操作、Cycle の Issue 一覧
export function CycleDetailPage() {
  const { cycleId } = route.useParams();
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/cycles/$cycleId" });
  const cycles = useCycles();
  const found = cycles.data?.some((c) => String(c.id) === cycleId) ?? false;
  const detail = useCycle(Number(cycleId), found);
  const rows = useIssueRows({ cycle: cycleId }, found);

  if (cycles.error) return <PageError message={errorMessage(cycles.error)} />;
  if (!cycles.data) return <PageLoading />;
  if (!found) return <NotFoundMessage title="Cycle が見つかりません" />;
  if (detail.error) return <PageError message={errorMessage(detail.error)} />;
  if (!detail.data) return <PageLoading />;
  const cycle = detail.data;
  const siblings = cycles.data.filter((c) => c.workspace === cycle.workspace);
  return (
    <IssueList
      crumb={<Link to="/cycles">Cycles</Link>}
      title={cycle.name}
      actions={<CycleStateBadge state={cycle.state} />}
      intro={<CycleOverview key={cycle.id} cycle={cycle} siblings={siblings} />}
      rows={rows.rows}
      loading={rows.loading}
      error={rows.error}
      search={search}
      statusWorkspace={cycle.workspace}
      onSearchChange={(patch) => navigate({ search: (prev) => cleanIssueListSearch({ ...prev, ...patch }), replace: replacesIssueListHistory(patch) })}
    />
  );
}

function CycleOverview({ cycle, siblings }: { cycle: CycleDetail; siblings: CycleSummary[] }) {
  const selectId = useId();
  const destinations = siblings.filter((c) => c.id !== cycle.id);
  const [to, setTo] = useState<number | undefined>(defaultDestination(cycle, siblings)?.id ?? destinations[0]?.id);
  const [confirming, setConfirming] = useState(false);
  const canMove = cycle.open > 0 && destinations.length > 0;
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
      <span className={s.spacer} />
      {canMove && (
        <>
          <label className={d.inlineSelect} htmlFor={selectId}>
            移動先
            <Icon name="calendar-range" size={13} color="var(--ink2)" />
            <select id={selectId} value={to ?? ""} onChange={(event) => setTo(Number(event.target.value))}>
              {destinations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（{CYCLE_STATE_LABEL[c.state]}）
                </option>
              ))}
            </select>
          </label>
          {/* Pencil は「次の Cycle へ移す」だが、移動先には終了した Cycle も選べるため「別の Cycle」とする */}
          <Button variant="primary" icon="arrow-right-to-line" disabled={to === undefined} onClick={() => setConfirming(true)}>
            未完了 {cycle.open} 件を別の Cycle へ移す
          </Button>
        </>
      )}
      {confirming && to !== undefined && (
        <MoveDialog cycle={cycle} destinations={destinations} initial={to} onClose={() => setConfirming(false)} />
      )}
    </section>
  );
}

// Pencil「Cycle詳細｜移動の確認」。状態は変えず、未完了の Issue の Cycle だけを変える
function MoveDialog({ cycle, destinations, initial, onClose }: { cycle: CycleDetail; destinations: CycleSummary[]; initial: number; onClose: () => void }) {
  const move = useMoveOpenIssues(cycle.id);
  const [to, setTo] = useState(initial);
  const target = destinations.find((c) => c.id === to);
  const open = cycle.issues.filter((i) => i.status !== "done" && i.status !== "canceled");
  return (
    <FormDialog
      title={`未完了 ${cycle.open} 件を ${target?.name ?? ""} へ移しますか？`}
      submitLabel="移す"
      busy={move.isPending}
      error={move.error ? errorMessage(move.error) : null}
      onClose={onClose}
      onSubmit={() => move.mutate({ to }, { onSuccess: onClose })}
    >
      <p className={d.message}>
        {open.map((i) => i.id).join("・")} の Cycle を {cycle.name} から {target?.name ?? ""} に変えます。状態は変わりません。
      </p>
      <label className={d.inlineSelect}>
        移動先
        <Icon name="calendar-range" size={13} color="var(--ink2)" />
        <select aria-label="移動先" value={to} onChange={(event) => setTo(Number(event.target.value))}>
          {destinations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}（{CYCLE_STATE_LABEL[c.state]}）
            </option>
          ))}
        </select>
      </label>
    </FormDialog>
  );
}
