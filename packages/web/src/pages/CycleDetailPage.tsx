import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { useCycle, useCycles } from "../api/hooks/cycles";
import { usePageDisplay } from "../api/hooks/page-displays";
import { useIssueRows } from "../api/hooks/issues";
import type { CycleDetail } from "../api/types";
import { DeleteCycleDialog } from "../components/cycles/DeleteCycleDialog";
import { EditCycleDialog } from "../components/cycles/EditCycleDialog";
import { IssueList } from "../components/issue-list/IssueList";
import { Icon, IconButton, Menu, MenuItem, PageError, PageLoading, ProgressBar } from "../components/ui";
import { formatCyclePeriod } from "../lib/cycles";
import { withoutPageDisplay } from "../lib/page-display";
import { cleanIssueListSearch, replacesIssueListHistory } from "../routes/search";
import { CycleStateBadge } from "./CyclesPage";
import { NotFoundMessage } from "./NotFoundPage";
import s from "./cycle-detail.module.css";

const route = getRouteApi("/cycles/$cycleId");

// Pencil「Cycle詳細（NOD-2）」。見出しの右に状態と「…」メニュー（編集・削除）、概要（期間・進捗・未完了）と、Cycle の Issue 一覧
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
      titleNote={<CycleStateBadge state={cycle.state} />}
      // 分析のボタン（Pencil「Cycle詳細｜分析パネル（NOD-2）」）は「…」の左に置く
      actions={<CycleMenu key={cycle.id} cycle={cycle} />}
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

// 見出しの右の「…」。編集と削除のダイアログを開く
function CycleMenu({ cycle }: { cycle: CycleDetail }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const choose = (next: "edit" | "delete") => {
    setOpen(false);
    setDialog(next);
  };
  return (
    <div className={s.menuWrap} ref={root}>
      <IconButton
        icon="ellipsis"
        label="Cycle の操作"
        bordered
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      />
      {open && (
        <Menu label="Cycle の操作" className={s.menu} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          <MenuItem ref={first} onClick={() => choose("edit")}>
            <Icon name="pencil" />
            編集
          </MenuItem>
          <MenuItem className={s.danger} onClick={() => choose("delete")}>
            <Icon name="trash-2" />
            削除
          </MenuItem>
        </Menu>
      )}
      {dialog === "edit" && <EditCycleDialog cycle={cycle} onClose={() => setDialog(null)} />}
      {dialog === "delete" && <DeleteCycleDialog cycle={cycle} onClose={() => setDialog(null)} />}
    </div>
  );
}
