import { type KeyboardEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { axisDate, labelEvery, niceTicks } from "../../lib/analytics";
import s from "./charts.module.css";

// nod.pen の Plot（512×210）に合わせる。左 28px に縦軸の目盛り、下 22px に期間の日付を置く
const HEIGHT = 210;
const LEFT = 28;
const TOP = 8;
const PLOT_H = 180;
const AXIS_Y = TOP + PLOT_H;

export interface Segment {
  key: string;
  value: number;
  color: string;
}

export interface Slot {
  start: string; // 期間の初日。軸の日付と行の key に使う
  label: string; // 読み上げと hover に出す説明
}

// グラフと同じ値を期間ごとの行で持つ表。画面には出さず、読み上げと値の確認に使う
export interface ChartTable {
  head: string[]; // 先頭は期間の列
  rows: string[][];
}

export function DataTable({ id, label, table }: { id: string; label: string; table: ChartTable }) {
  return (
    <table id={id} className={s.visuallyHidden}>
      <caption>{label}</caption>
      <thead>
        <tr>{table.head.map((h, n) => <th key={n} scope="col">{h}</th>)}</tr>
      </thead>
      <tbody>
        {table.rows.map((row, r) => (
          <tr key={r}>
            {row.map((cell, n) => (n === 0 ? <th key={n} scope="row">{cell}</th> : <td key={n}>{cell}</td>))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// 親の幅に合わせて描く。SVG を伸縮させると文字が歪むため、幅を測って座標を計算する
export function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(512);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.max(240, el.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function Frame({ label, describedBy, width, ticks, format, slots, children, ...focus }: {
  label: string;
  describedBy: string;
  tabIndex?: number;
  onFocus?: () => void;
  onBlur?: () => void;
  onKeyDown?: (event: KeyboardEvent<SVGSVGElement>) => void;
  width: number;
  ticks: number[];
  format: (value: number) => string;
  slots: Slot[];
  children: ReactNode;
}) {
  const slotW = (width - LEFT) / Math.max(1, slots.length);
  const every = labelEvery(slots.length);
  const top = ticks.at(-1) ?? 1;
  return (
    <svg className={s.svg} width={width} height={HEIGHT} role="img" aria-label={label} aria-describedby={describedBy} {...focus}>
      {ticks.map((t) => {
        const y = AXIS_Y - (t / top) * PLOT_H;
        return (
          <g key={t}>
            <rect x={LEFT} y={y} width={width - LEFT} height={1} fill={t === 0 ? "var(--ink3)" : "var(--line)"} />
            <text className={s.axis} x={22} y={y + 4} textAnchor="end">{format(t)}</text>
          </g>
        );
      })}
      {slots.map((slot, n) =>
        n % every === 0 ? (
          <text key={slot.start} className={s.axis} x={LEFT + slotW * (n + 0.5)} y={AXIS_Y + 17} textAnchor="middle">
            {axisDate(slot.start)}
          </text>
        ) : null,
      )}
      {children}
    </svg>
  );
}

function scale(value: number, top: number): number {
  return (value / top) * PLOT_H;
}

// 期間ごとに系列を横に並べた縦棒（例: 完了と canceled）
export function GroupedBars({ label, slots, series, table }: { label: string; slots: Slot[]; series: Segment[][]; table: ChartTable }) {
  const [ref, width] = useWidth();
  const tableId = useId();
  const ticks = niceTicks(Math.max(0, ...series.flat().map((x) => x.value)));
  const top = ticks.at(-1)!;
  const slotW = (width - LEFT) / Math.max(1, slots.length);
  const barW = Math.max(2, Math.min(12, slotW * 0.3));
  return (
    <div ref={ref} className={s.plot}>
      <Frame label={label} describedBy={tableId} width={width} ticks={ticks} format={String} slots={slots}>
        {slots.map((slot, n) => {
          const bars = series[n] ?? [];
          const x0 = LEFT + slotW * (n + 0.5) - (bars.length * barW + (bars.length - 1) * 2) / 2;
          return (
            <g key={slot.start}>
              <title>{`${slot.label}: ${bars.map((b) => `${b.key} ${b.value}`).join("・")}`}</title>
              <rect x={LEFT + slotW * n} y={TOP} width={slotW} height={PLOT_H} fill="transparent" />
              {bars.map((b, i) => b.value > 0 && (
                <path key={b.key} d={topRounded(x0 + i * (barW + 2), AXIS_Y - scale(b.value, top), barW, scale(b.value, top))} fill={b.color} data-series={b.key} />
              ))}
            </g>
          );
        })}
      </Frame>
      <DataTable id={tableId} label={label} table={table} />
    </div>
  );
}

// 期間ごとに系列を積み上げた縦棒。最初の系列を下に置き、一番上の段だけ角を丸める
export function StackedBars({ label, slots, series, table }: { label: string; slots: Slot[]; series: Segment[][]; table: ChartTable }) {
  const [ref, width] = useWidth();
  const tableId = useId();
  const ticks = niceTicks(Math.max(0, ...series.map((stack) => stack.reduce((sum, x) => sum + x.value, 0))));
  const top = ticks.at(-1)!;
  const slotW = (width - LEFT) / Math.max(1, slots.length);
  const barW = Math.max(3, Math.min(18, slotW * 0.45));
  return (
    <div ref={ref} className={s.plot}>
      <Frame label={label} describedBy={tableId} width={width} ticks={ticks} format={String} slots={slots}>
        {slots.map((slot, n) => {
          const stack = (series[n] ?? []).filter((x) => x.value > 0);
          const x = LEFT + slotW * (n + 0.5) - barW / 2;
          let y = AXIS_Y;
          return (
            <g key={slot.start}>
              <title>{`${slot.label}: ${stack.map((b) => `${b.key} ${b.value}`).join("・") || "0"}`}</title>
              <rect x={LEFT + slotW * n} y={TOP} width={slotW} height={PLOT_H} fill="transparent" />
              {stack.map((b, i) => {
                const h = scale(b.value, top);
                y -= h;
                const d = i === stack.length - 1 ? topRounded(x, y, barW, h) : `M${x} ${y}h${barW}v${h}h${-barW}z`;
                return <path key={b.key} d={d} fill={b.color} data-series={b.key} />;
              })}
            </g>
          );
        })}
      </Frame>
      <DataTable id={tableId} label={label} table={table} />
    </div>
  );
}

export interface LinePoint {
  value: number | null; // null の期間は点を打たず、線をつながない
  tooltip: [string, string]; // hover で出す見出しと詳細
}

// 期間ごとの値の折れ線。点に乗ると縦の案内線と値の吹き出しを出す。
// キーボードではグラフにフォーカスして ←→（Home・End）で値のある点を移る
export function LineChart({ label, slots, points, format, minStep, table }: {
  label: string;
  slots: Slot[];
  points: LinePoint[];
  format: (value: number) => string;
  minStep: number;
  table: ChartTable;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const tableId = useId();
  const tooltipId = useId();
  const ticks = niceTicks(Math.max(0, ...points.map((p) => p.value ?? 0)), minStep);
  const top = ticks.at(-1)!;
  const slotW = (width - LEFT) / Math.max(1, slots.length);
  const xy = points.map((p, n) => (p.value === null ? null : { x: LEFT + slotW * (n + 0.5), y: AXIS_Y - scale(p.value, top) }));
  let d = "";
  xy.forEach((p, n) => {
    if (p) d += `${n > 0 && xy[n - 1] ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  });
  const active = hover === null ? null : xy[hover];
  const valued = xy.flatMap((p, n) => (p ? [n] : []));
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (valued.length === 0) return;
    const at = hover === null ? -1 : valued.indexOf(hover);
    const next = {
      ArrowLeft: valued[Math.max(0, at - 1)],
      ArrowRight: valued[Math.min(valued.length - 1, at + 1)],
      Home: valued[0],
      End: valued.at(-1),
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setHover(next);
  };
  return (
    <div ref={ref} className={s.plot} onMouseLeave={() => setHover(null)}>
      <Frame
        label={label}
        describedBy={active ? `${tableId} ${tooltipId}` : tableId}
        width={width}
        ticks={ticks}
        format={format}
        slots={slots}
        tabIndex={0}
        onFocus={() => setHover(valued.at(-1) ?? null)}
        onBlur={() => setHover(null)}
        onKeyDown={onKeyDown}
      >
        {active && <rect x={active.x} y={TOP} width={1} height={PLOT_H} fill="var(--line)" />}
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {xy.map((p, n) =>
          p ? (
            hover === n
              ? <circle key={n} cx={p.x} cy={p.y} r={4} fill="var(--surface)" stroke="var(--accent)" strokeWidth={2} />
              : <circle key={n} cx={p.x} cy={p.y} r={3} fill="var(--accent)" />
          ) : null,
        )}
        {slots.map((slot, n) => (
          <rect
            key={slot.start}
            x={LEFT + slotW * n}
            y={TOP}
            width={slotW}
            height={PLOT_H}
            fill="transparent"
            onMouseEnter={() => setHover(xy[n] ? n : null)}
          >
            <title>{points[n]!.tooltip.join("、")}</title>
          </rect>
        ))}
      </Frame>
      {active && hover !== null && (
        <div
          id={tooltipId}
          className={s.tooltip}
          role="tooltip"
          style={{ left: Math.min(active.x + 8, width - 150), top: Math.max(0, active.y - 58) }}
        >
          <span className={s.tooltipHead}>{points[hover]!.tooltip[0]}</span>
          <span className={s.tooltipDetail}>{points[hover]!.tooltip[1]}</span>
        </div>
      )}
      <DataTable id={tableId} label={label} table={table} />
    </div>
  );
}

// 上の2つの角だけを 2px 丸めた棒
function topRounded(x: number, y: number, w: number, h: number): string {
  const r = Math.min(2, w / 2, h);
  return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`;
}

export function Legend({ items }: { items: { key: string; color: string; line?: boolean }[] }) {
  return (
    <div className={s.legend}>
      {items.map((item) => (
        <span key={item.key} className={s.legendItem}>
          <span className={item.line ? s.legendLine : s.legendKey} style={{ background: item.color }} />
          {item.key}
        </span>
      ))}
    </div>
  );
}
