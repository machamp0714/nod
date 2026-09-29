import { getRouteApi, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCompletionStats } from "../api/hooks/analytics";
import { useProjects } from "../api/hooks/projects";
import { useWorkspaces } from "../api/hooks/shared";
import { errorMessage } from "../api/errors";
import type { CompletionStats } from "../api/types";
import { GroupedBars, Legend, LineChart } from "../components/analytics/charts";
import { LlmSection } from "../components/analytics/LlmSection";
import { Card, slotsOf } from "../components/analytics/parts";
import { Icon, PageError, PageLoading } from "../components/ui";
import {
  type AnalyticsSearch,
  cleanAnalyticsSearch,
  DEFAULT_RANGE,
  formatHours,
  RANGE_PRESETS,
  rangeLabel,
  type StatsBy,
  statsQueryString,
} from "../lib/analytics";
import s from "./analytics.module.css";

const route = getRouteApi("/analytics");
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const UNIT: Record<StatsBy, string> = { day: "日", week: "週" };

export function AnalyticsPage() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/analytics" });
  const by = search.by ?? "week";
  const range = search.range ?? DEFAULT_RANGE[by];
  const query = statsQueryString(search, new Date(), BROWSER_TZ);
  const stats = useCompletionStats(query);
  const update = (next: AnalyticsSearch) => navigate({ search: cleanAnalyticsSearch(next), replace: true });
  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>Analytics</h1>
        <span className={s.spacer} />
        <FilterBar search={search} by={by} range={range} onChange={update} />
      </header>
      <div className={s.content}>
        {stats.error ? (
          <PageError message={errorMessage(stats.error)} />
        ) : !stats.data ? (
          <PageLoading />
        ) : (
          <CompletionSection stats={stats.data} rangeText={rangeLabel(by, range)} />
        )}
        <LlmSection query={query} />
      </div>
    </div>
  );
}

function FilterBar({ search, by, range, onChange }: {
  search: AnalyticsSearch;
  by: StatsBy;
  range: number;
  onChange: (next: AnalyticsSearch) => void;
}) {
  const workspaces = useWorkspaces();
  const projects = useProjects();
  return (
    <div className={s.filters}>
      <div role="tablist" aria-label="期間の単位" className={s.segmented}>
        {(["day", "week"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={value === by}
            className={`${s.segment} ${value === by ? s.segmentActive : ""}`}
            onClick={() => onChange({ ...search, by: value, range: undefined })}
          >
            {UNIT[value]}
          </button>
        ))}
      </div>
      <SelectChip label="範囲" value={String(range)} onChange={(v) => onChange({ ...search, range: Number(v) })}>
        {RANGE_PRESETS[by].map((n) => <option key={n} value={n}>{rangeLabel(by, n)}</option>)}
      </SelectChip>
      <SelectChip label="Workspace" value={search.workspace ?? ""} onChange={(v) => onChange({ ...search, workspace: v || undefined })}>
        <option value="">すべて</option>
        {(workspaces.data ?? []).map((w) => <option key={w.key} value={w.key}>{w.name}</option>)}
      </SelectChip>
      <SelectChip label="Project" value={search.project ?? ""} onChange={(v) => onChange({ ...search, project: v || undefined })}>
        <option value="">すべて</option>
        {(projects.data ?? []).map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
      </SelectChip>
    </div>
  );
}

// ラベルつきの選択。見た目は nod.pen の Select（枠・ラベル・値・下向き矢印）で、操作はネイティブの select に任せる
function SelectChip({ label, value, onChange, children }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className={s.select}>
      <span className={s.selectLabel}>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      <Icon name="chevron-down" size={12} color="var(--ink3)" />
    </label>
  );
}

function CompletionSection({ stats, rangeText }: { stats: CompletionStats; rangeText: string }) {
  // canceled だけの期間も系列を見せ、どちらも無いときだけ空の状態にする
  if (stats.totals.completed === 0 && stats.totals.canceled === 0) {
    return (
      <div className={s.empty}>
        <Icon name="chart-column" size={24} color="var(--ink3)" />
        <span className={s.emptyText}>この期間に完了した Issue はありません</span>
      </div>
    );
  }
  const slots = slotsOf(stats.buckets, stats.by);
  const unit = UNIT[stats.by];
  return (
    <>
      <div className={s.kpis}>
        <Kpi label="完了数" value={String(stats.totals.completed)} sub={`${rangeText} · canceled ${stats.totals.canceled} 件は除く`} />
        <Kpi label="作業時間 中央値" value={formatHours(stats.totals.work.medianMinutes)} sub="着手 → レビュー提出" />
        <Kpi label="記録なし件数" value={String(stats.totals.work.unrecorded)} sub="作業時間を算出できない完了 Issue" />
      </div>
      <div className={s.row}>
        <Card title={`${unit}ごとの完了数`} legend={<Legend items={[{ key: "完了", color: "var(--accent)" }, { key: "canceled", color: "var(--line)" }]} />}>
          <GroupedBars
            label={`${unit}ごとの完了数`}
            slots={slots}
            series={stats.buckets.map((b) => [
              { key: "完了", value: b.completed, color: "var(--accent)" },
              { key: "canceled", value: b.canceled, color: "var(--line)" },
            ])}
            table={{
              head: [unit, "完了", "canceled"],
              rows: stats.buckets.map((b, n) => [slots[n]!.label, String(b.completed), String(b.canceled)]),
            }}
          />
        </Card>
        <Card title={`${unit}ごとの作業時間 中央値`} legend={<Legend items={[{ key: "中央値", color: "var(--accent)", line: true }]} />}>
          <LineChart
            label={`${unit}ごとの作業時間 中央値`}
            slots={slots}
            minStep={0.1}
            format={(h) => `${h}h`}
            points={stats.buckets.map((b, n) => ({
              value: b.work.medianMinutes === null ? null : b.work.medianMinutes / 60,
              tooltip: [
                `${slots[n]!.label} · 中央値 ${formatHours(b.work.medianMinutes)}`,
                `件数 ${b.work.measured}・合計 ${formatHours(b.work.totalMinutes)}`,
              ],
            }))}
            table={{
              head: [unit, "中央値", "件数", "合計", "記録なし"],
              rows: stats.buckets.map((b, n) => [
                slots[n]!.label,
                formatHours(b.work.medianMinutes),
                String(b.work.measured),
                b.work.measured ? formatHours(b.work.totalMinutes) : "—",
                String(b.work.unrecorded),
              ]),
            }}
          />
        </Card>
      </div>
    </>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <section className={s.kpi} aria-label={label}>
      <span className={s.kpiLabel}>{label}</span>
      <span className={s.kpiValue}>{value}</span>
      <span className={s.kpiSub}>{sub}</span>
    </section>
  );
}
