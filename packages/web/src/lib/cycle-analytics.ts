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

const DAY_MS = 86_400_000;

// 日付は4桁の年までしか扱えない。終了日がこれより後でも、ここで打ち切る
const MAX_DATE = "9999-12-31";

// グラフと表に出す点の上限。これより長い Cycle は均等に間引く
const MAX_POINTS = 120;

const toTime = (date: string) => Date.parse(`${date}T00:00:00Z`);
const toDate = (time: number) => new Date(time).toISOString().slice(0, 10);

// Cycle graph の系列。横軸は期間の日（MAX_POINTS 日を超える期間は間引き、初日・終了日・推移の最終日は残す）で、
// まだ来ていない日は null（線を引かない）。Started は Completed の上に積む（Linear と同じ）。
// Target は開始日 0 から終了日に今の Scope までの直線
export function graphSeries(burnup: CycleAnalytics["burnup"], startDate: string, endDate: string) {
  const first = toTime(startDate);
  const span = Math.max(0, Math.round((toTime(endDate < MAX_DATE ? endDate : MAX_DATE) - first) / DAY_MS));
  const offsets = new Set<number>();
  if (span < MAX_POINTS) {
    for (let i = 0; i <= span; i++) offsets.add(i);
  } else {
    for (let k = 0; k < MAX_POINTS; k++) offsets.add(Math.round((k * span) / (MAX_POINTS - 1)));
    const lastBurnup = burnup.at(-1);
    if (lastBurnup) offsets.add(Math.round((toTime(lastBurnup.date) - first) / DAY_MS));
  }
  const sorted = [...offsets].filter((i) => i >= 0 && i <= span).sort((a, b) => a - b);
  const days = sorted.map((i) => toDate(first + i * DAY_MS));
  const byDate = new Map(burnup.map((b) => [b.date, b]));
  const at = days.map((d) => byDate.get(d));
  const finalScope = burnup.at(-1)?.scope ?? 0;
  return {
    days,
    scope: at.map((b) => b?.scope ?? null),
    started: at.map((b) => b?.started ?? null),
    startedStack: at.map((b) => (b ? b.started + b.completed : null)),
    completed: at.map((b) => b?.completed ?? null),
    target: sorted.map((i) => (span === 0 ? finalScope : (finalScope * i) / span)),
    max: burnup.reduce((m, b) => Math.max(m, b.scope), Math.max(1, finalScope)),
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
