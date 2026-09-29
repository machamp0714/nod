// Analytics 画面の純粋な計算。条件は URL の search に持ち、API の /api/stats と /api/stats/llm に渡す

export type StatsBy = "day" | "week";

export interface AnalyticsSearch {
  by?: StatsBy;
  range?: number; // 直近いくつの期間を出すか（プリセットのどれか）
  workspace?: string; // Workspace のキー
  project?: string; // Project の数字の ID
}

export const RANGE_PRESETS: Record<StatsBy, readonly number[]> = { day: [7, 14, 30, 90], week: [4, 12, 26, 52] };
export const DEFAULT_RANGE: Record<StatsBy, number> = { day: 30, week: 12 };

// URL を手で書き換えられても既定の表示に戻れるよう、知らない値は捨てる。
// Router は元の search に戻り値を重ねるため、不正な値のキーは undefined で上書きする
export function parseAnalyticsSearch(raw: Record<string, unknown>): AnalyticsSearch {
  const by = raw.by === "day" || raw.by === "week" ? raw.by : undefined;
  const range = Number(raw.range);
  const workspace = typeof raw.workspace === "string" && raw.workspace.trim() ? raw.workspace.trim().toUpperCase() : undefined;
  const project = typeof raw.project === "number" ? String(raw.project) : raw.project;
  const out: AnalyticsSearch = {
    by,
    range: RANGE_PRESETS[by ?? "week"].includes(range) ? range : undefined,
    workspace,
    project: typeof project === "string" && /^[1-9]\d*$/.test(project) ? project : undefined,
  };
  for (const key of Object.keys(out) as (keyof AnalyticsSearch)[]) {
    if (out[key] === undefined && !(key in raw)) delete out[key];
  }
  return out;
}

// 既定値と同じものは URL に残さない
export function cleanAnalyticsSearch(search: AnalyticsSearch): AnalyticsSearch {
  const by = search.by ?? "week";
  const out: AnalyticsSearch = {};
  if (by !== "week") out.by = by;
  if (search.range !== undefined && search.range !== DEFAULT_RANGE[by] && RANGE_PRESETS[by].includes(search.range)) out.range = search.range;
  if (search.workspace) out.workspace = search.workspace;
  if (search.project) out.project = search.project;
  return out;
}

export function rangeLabel(by: StatsBy, range: number): string {
  return `直近${range}${by === "day" ? "日" : "週"}`;
}

function localDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

// 今日（ブラウザの暦日）を終わりとして、直近 range 個の期間の from/to を求める。週は月曜始まり
export function statsRange(by: StatsBy, range: number, today: Date): { from: string; to: string } {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (by === "day") start.setDate(start.getDate() - (range - 1));
  else start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - (range - 1) * 7);
  return { from: localDate(start), to: localDate(today) };
}

// API のクエリ文字列。期間の境界はブラウザのタイムゾーンで決める
export function statsQueryString(search: AnalyticsSearch, today: Date, tz: string): string {
  const by = search.by ?? "week";
  const { from, to } = statsRange(by, search.range ?? DEFAULT_RANGE[by], today);
  const params = new URLSearchParams({ by, from, to, tz });
  if (search.workspace) params.set("workspace", search.workspace);
  if (search.project) params.set("project", search.project);
  return params.toString();
}

// 作業時間は時間の小数1桁で出す（例: 3.2h）
export function formatHours(minutes: number | null): string {
  return minutes === null ? "—" : `${(minutes / 60).toFixed(1)}h`;
}

// 期間の初日 YYYY-MM-DD を軸の M/D にする
export function axisDate(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}`;
}

// 0 から max を覆う目盛り。間隔は 1・2・5 の10の累乗倍で、4本前後にする
export function niceTicks(max: number, minStep = 1): number[] {
  if (max <= 0) return [0, minStep];
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(minStep, ([1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power));
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, n) => Number((n * step).toFixed(6)));
}

// 軸の文字が重ならないよう、期間が多いときは n 個おきにだけ出す
export function labelEvery(count: number, max = 12): number {
  return Math.max(1, Math.ceil(count / max));
}
