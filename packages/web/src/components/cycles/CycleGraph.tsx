import { useId } from "react";
import type { CycleAnalytics } from "../../api/types";
import { graphSeries, shortDate } from "../../lib/cycle-analytics";
import { DataTable, Legend, useWidth } from "../analytics/charts";
import s from "./cycle-analytics.module.css";

// Pencil「Cycle詳細｜分析パネル（NOD-2）」の Plot（330×140）。上端と中ほどに補助線を引く
const HEIGHT = 140;

// Started の線と四角の色。tokens に黄色がないため --ask を使う（Pencil は #E2A93B）
export const CYCLE_COLORS = { scope: "var(--ink3)", started: "var(--ask)", completed: "var(--accent)", target: "var(--accent)" } as const;

// Linear の Cycle graph。Scope・Started（Completed に積む）・Completed の線と、Completed の日ごとの薄い棒、
// Target の破線、今日の縦線。today は現在の Cycle のときだけ渡す
export function CycleGraph({ analytics, startDate, endDate, today }: {
  analytics: CycleAnalytics;
  startDate: string;
  endDate: string;
  today: string | null;
}) {
  const [ref, width] = useWidth();
  const tableId = useId();
  const g = graphSeries(analytics.burnup, startDate, endDate);
  const slotW = width / Math.max(1, g.days.length);
  const x = (n: number) => slotW * (n + 0.5);
  const y = (v: number) => HEIGHT - (v / g.max) * HEIGHT;
  const line = (values: (number | null)[]) => {
    let d = "";
    values.forEach((v, n) => {
      if (v !== null) d += `${n > 0 && values[n - 1] !== null ? "L" : "M"}${x(n).toFixed(1)} ${y(v).toFixed(1)}`;
    });
    return d;
  };
  const todayAt = today ? g.days.indexOf(today) : -1;
  const table = {
    head: ["日付", "Scope", "Started", "Completed", "Target"],
    rows: g.days.map((d, n) => [d, String(g.scope[n] ?? "—"), String(g.started[n] ?? "—"), String(g.completed[n] ?? "—"), g.target[n]!.toFixed(1)]),
  };
  return (
    <div className={s.graph}>
      <div ref={ref} className={s.plot}>
        <svg className={s.svg} width={width} height={HEIGHT} role="img" aria-label="Cycle graph" aria-describedby={tableId}>
          <rect x={0} y={0} width={width} height={1} fill="var(--line)" />
          <rect x={0} y={HEIGHT / 2} width={width} height={1} fill="var(--line)" />
          {g.completed.map((v, n) =>
            v ? <rect key={g.days[n]} x={x(n) - slotW / 4} y={y(v)} width={slotW / 2} height={HEIGHT - y(v)} fill="var(--accent-soft)" /> : null,
          )}
          <path d={line(g.target)} fill="none" stroke={CYCLE_COLORS.target} strokeWidth={1.5} strokeDasharray="4 4" opacity={0.7} />
          <path d={line(g.scope)} fill="none" stroke={CYCLE_COLORS.scope} strokeWidth={1.5} strokeLinejoin="round" />
          <path d={line(g.startedStack)} fill="none" stroke={CYCLE_COLORS.started} strokeWidth={1.5} strokeLinejoin="round" />
          <path d={line(g.completed)} fill="none" stroke={CYCLE_COLORS.completed} strokeWidth={2} strokeLinejoin="round" />
          {todayAt >= 0 && <rect x={x(todayAt)} y={0} width={1} height={HEIGHT} fill="var(--ink3)" opacity={0.4} />}
        </svg>
        <DataTable id={tableId} label="Cycle graph の日ごとの値" table={table} />
      </div>
      <div className={s.axis}>
        <span>{shortDate(startDate)}</span>
        {todayAt >= 0 && <span>今日</span>}
        <span>{shortDate(endDate)}</span>
      </div>
      <Legend
        items={[
          { key: "Scope", color: CYCLE_COLORS.scope, line: true },
          { key: "Started", color: CYCLE_COLORS.started, line: true },
          { key: "Completed", color: CYCLE_COLORS.completed, line: true },
          { key: "Target", color: CYCLE_COLORS.target, line: true },
        ]}
      />
    </div>
  );
}
