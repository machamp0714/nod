import { type KeyboardEvent, useId, useRef, useState } from "react";
import { useCycleAnalytics } from "../../api/hooks/cycles";
import type { CycleAnalytics, CycleBreakdownRow, CycleDetail } from "../../api/types";
import { breakdownLabel, formatRate, formatScopeAdded, panelPeriod } from "../../lib/cycle-analytics";
import { statusLabel } from "../../lib/meta";
import { AgentAvatar, ErrorMessage, Icon, IconButton, LabelDot, LoadingMessage, ProgressBar, StatusIcon, WorkspaceBadge } from "../ui";
import { CYCLE_COLORS, CycleGraph } from "./CycleGraph";
import s from "./cycle-analytics.module.css";

const TABS = [
  { key: "assignees", label: "Assignees" },
  { key: "labels", label: "Labels" },
  { key: "projects", label: "Projects" },
  { key: "workspaces", label: "Workspaces" },
  { key: "status", label: "Status" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

// Pencil「Cycle詳細｜分析パネル（NOD-2）」。Linear の Cycle の右パネルと同じく、上から見出し・進捗・Cycle graph・内訳。
// 閉じたときは親が外す（描いたまま画面外へ寄せない）
export function CycleAnalyticsPanel({ cycle, onClose }: { cycle: CycleDetail; onClose: () => void }) {
  const analytics = useCycleAnalytics(cycle.id, true);
  const data = analytics.data;
  // 推移は server が今日で打ち切るため、現在の Cycle では最終日が今日
  const today = cycle.state === "current" ? (data?.burnup.at(-1)?.date ?? null) : null;
  return (
    <aside className={s.panel} aria-label="Cycle の分析">
      <header className={s.header}>
        <Icon name="calendar-range" color="var(--ink2)" />
        <span className={s.title}>{cycle.name}</span>
        <span className={s.dates}>{panelPeriod(cycle, today)}</span>
        <span className={s.spacer} />
        <IconButton icon="x" label="分析を閉じる" onClick={onClose} />
      </header>
      <div className={s.body}>
        {analytics.error ? (
          <ErrorMessage error={analytics.error} />
        ) : !data ? (
          <LoadingMessage />
        ) : (
          <>
            <section className={s.progress} aria-label="進捗">
              <Metric label="Scope" color={CYCLE_COLORS.scope} value={data.scope} sub={formatScopeAdded(data.scopeAdded)} />
              <Metric label="Started" color={CYCLE_COLORS.started} value={data.started} sub={formatRate(data.startedRate)} />
              <Metric label="Completed" color={CYCLE_COLORS.completed} value={data.completed} sub={formatRate(data.completedRate)} />
            </section>
            <section aria-label="Cycle graph">
              {data.burnup.length === 0 ? (
                <p className={s.empty}>開始前です</p>
              ) : (
                <CycleGraph analytics={data} startDate={cycle.startDate} endDate={cycle.endDate} today={today} />
              )}
            </section>
            <Breakdown analytics={data} />
          </>
        )}
      </div>
    </aside>
  );
}

function Metric({ label, color, value, sub }: { label: string; color: string; value: number; sub: string }) {
  return (
    <div className={s.metric}>
      <span className={s.metricHead}>
        <span className={s.swatch} style={{ background: color }} />
        {label}
      </span>
      <span className={s.metricValue}>
        <span className={s.number}>{value}</span>
        {sub && <span className={s.sub}>{sub}</span>}
      </span>
    </div>
  );
}

// 内訳のタブ。←→・Home・End でタブを移る（WAI-ARIA の Tabs と同じ）
function Breakdown({ analytics }: { analytics: CycleAnalytics }) {
  const [tab, setTab] = useState<TabKey>("assignees");
  const id = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex((t) => t.key === tab);
    const next = { ArrowLeft: (at + TABS.length - 1) % TABS.length, ArrowRight: (at + 1) % TABS.length, Home: 0, End: TABS.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setTab(TABS[next]!.key);
    tabs.current[next]?.focus();
  };
  return (
    <section className={s.breakdown} aria-label="内訳">
      <div className={s.tabs} role="tablist" aria-label="内訳の種類" onKeyDown={onKeyDown}>
        {TABS.map((t, n) => (
          <button
            key={t.key}
            ref={(el) => {
              tabs.current[n] = el;
            }}
            type="button"
            role="tab"
            id={`${id}-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`${id}-panel`}
            tabIndex={tab === t.key ? 0 : -1}
            className={s.tab}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
        {tab === "status" ? (
          <ul className={s.rows}>
            {analytics.statuses.map((x) => (
              <li key={x.status} className={s.row}>
                <StatusIcon status={x.status} />
                <span className={s.name}>{statusLabel(x.status)}</span>
                <span className={s.spacer} />
                <span className={s.count}>{x.count}</span>
              </li>
            ))}
          </ul>
        ) : (
          <BreakdownRows kind={tab} rows={analytics.breakdown[tab]} />
        )}
      </div>
    </section>
  );
}

function BreakdownRows({ kind, rows }: { kind: Exclude<TabKey, "status">; rows: CycleBreakdownRow[] }) {
  if (rows.length === 0) return <p className={s.empty}>Issue がありません</p>;
  return (
    <ul className={s.rows}>
      {rows.map((row) => (
        <li key={row.key} className={s.row}>
          {kind === "workspaces" ? (
            <WorkspaceBadge workspaceKey={row.key} name={row.label} />
          ) : (
            <>
              {kind === "assignees" && row.key !== "" && <AgentAvatar actor={row.key} />}
              {kind === "labels" && <LabelDot workspace={null} name={row.key} />}
              <span className={s.name}>{row.label}</span>
            </>
          )}
          <span className={s.spacer} />
          <ProgressBar value={row.done} max={row.total} width={48} />
          <span className={s.count}>{breakdownLabel(row)}</span>
        </li>
      ))}
    </ul>
  );
}
