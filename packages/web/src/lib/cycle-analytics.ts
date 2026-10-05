import type { Cycle, CycleAnalytics } from "../api/types";

export function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

export function formatScopeAdded(n: number): string {
  return n === 0 ? "" : `開始後 ${n > 0 ? "+" : ""}${n}`;
}

// 内訳の行の右端「60% of 5」（Linear と同じ表記）
export function breakdownLabel(row: { total: number; done: number }): string {
  return `${formatRate(row.total === 0 ? null : row.done / row.total)} of ${row.total}`;
}

function addDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Cycle graph の系列。横軸は期間の全日で、まだ来ていない日は null（線を引かない）。
// Started は Completed の上に積む（Linear と同じ）。Target は開始日 0 から終了日に今の Scope までの直線
export function graphSeries(burnup: CycleAnalytics["burnup"], startDate: string, endDate: string) {
  const days: string[] = [];
  for (let d = startDate; d <= endDate; d = addDay(d)) days.push(d);
  const at = (d: string) => burnup.find((b) => b.date === d);
  const finalScope = burnup.at(-1)?.scope ?? 0;
  return {
    days,
    scope: days.map((d) => at(d)?.scope ?? null),
    startedStack: days.map((d) => {
      const b = at(d);
      return b ? b.started + b.completed : null;
    }),
    completed: days.map((d) => at(d)?.completed ?? null),
    target: days.map((_, i) => (days.length === 1 ? finalScope : (finalScope * i) / (days.length - 1))),
    max: Math.max(1, finalScope, ...burnup.map((b) => b.scope)),
  };
}

// 「10/06」。分析パネルの見出しとグラフの横軸に使う
export function shortDate(date: string): string {
  return `${date.slice(5, 7)}/${date.slice(8, 10)}`;
}

// 分析パネルの見出しの「10/06 – 10/19 · 残り 5 日」。残りは現在の Cycle だけ、今日から終了日までの日数（今日は数えない）。
// 今日は推移の最終日（server が今日で打ち切る）を渡す
export function panelPeriod(cycle: Pick<Cycle, "startDate" | "endDate" | "state">, today: string | null): string {
  const period = `${shortDate(cycle.startDate)} – ${shortDate(cycle.endDate)}`;
  if (cycle.state !== "current" || !today) return period;
  const days = Math.round((Date.parse(`${cycle.endDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return `${period} · 残り ${days} 日`;
}
