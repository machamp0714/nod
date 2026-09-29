import type { Database } from "bun:sqlite";
import { NodError } from "../errors";
import { recordedTimestamp } from "../recorded-time";
import { findWorkspace } from "./workspaces";
import { resolveProject } from "./projects";

export const STATS_GRANULARITIES = ["day", "week"] as const;
export type StatsGranularity = (typeof STATS_GRANULARITIES)[number];

export interface StatsQuery {
  by?: StatsGranularity; // 省略時は week
  from?: string; // YYYY-MM-DD（tz の暦日）。省略時は 日=直近30日、週=直近12週
  to?: string; // YYYY-MM-DD（tz の暦日、この日を含む）。省略時は今日
  tz?: string; // IANA のタイムゾーン名。省略時は実行環境のローカル
  workspace?: string[]; // Workspace のキー。どれかに合うもの
  project?: string; // Project の名前か ID
  now?: Date; // テスト用。既定の範囲の基準
}

// 作業時間の集計。Reviews と同じく、記録から求められない Issue は unrecorded に数える
export interface WorkTime {
  measured: number;
  unrecorded: number;
  medianMinutes: number | null;
  totalMinutes: number;
}

export interface CompletionBucket {
  start: string; // 期間の初日（YYYY-MM-DD）
  end: string; // 期間の最終日（この日を含む）
  completed: number;
  canceled: number;
  work: WorkTime;
}

export interface StatsRange {
  by: StatsGranularity;
  from: string;
  to: string;
  tz: string;
}

export interface CompletionStats extends StatsRange {
  buckets: CompletionBucket[];
  totals: Omit<CompletionBucket, "start" | "end">;
}

const QUERY_KEYS = ["by", "from", "to", "tz", "workspace", "project"];

// API のクエリパラメータを StatsQuery にする。workspace だけは複数指定できる
export function statsQueryFromParams(params: URLSearchParams): StatsQuery {
  const unknownKeys = [...new Set(params.keys())].filter((k) => !QUERY_KEYS.includes(k));
  if (unknownKeys.length) throw invalid(`${unknownKeys.join(", ")} は受け付けません（使えるもの: ${QUERY_KEYS.join(", ")}）`);
  const q: StatsQuery = {};
  for (const key of ["by", "from", "to", "tz", "project"] as const) {
    const values = params.getAll(key);
    if (values.length > 1) throw invalid(`${key} は1つだけ指定してください`);
    if (values[0] !== undefined) (q as Record<string, string>)[key] = values[0];
  }
  const workspace = params.getAll("workspace").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  if (workspace.length) q.workspace = workspace;
  return q;
}

const DAY_MS = 86_400_000;
const MAX_BUCKETS = 400;

function invalid(message: string): NodError {
  return new NodError("INVALID_ARGS", message);
}

// YYYY-MM-DD を UTC 0時の Date として扱い、暦日の計算に使う
function parseDate(value: string, what: string): number {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const at = parts ? Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) : NaN;
  if (!parts || new Date(at).toISOString().slice(0, 10) !== value) {
    throw invalid(`${what}は YYYY-MM-DD の実在する日付で指定してください（${value}）`);
  }
  return at;
}

function formatDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function mondayOf(at: number): number {
  return at - ((new Date(at).getUTCDay() + 6) % 7) * DAY_MS;
}

function dateFormatter(tz: string | undefined): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    throw invalid(`タイムゾーン ${tz} はありません。Asia/Tokyo のような IANA の名前で指定してください`);
  }
}

// 集計の範囲と期間の区切り。記録時刻を tz の暦日に直して期間を引く
export interface StatsFrame extends StatsRange {
  buckets: { start: string; end: string }[];
  bucketOf(timestamp: number): number; // 範囲外なら -1
  since: string; // SQL で絞る UTC の下限（余裕を持たせ、正確な判定は bucketOf で行う）
  until: string;
}

export function statsFrame(q: StatsQuery): StatsFrame {
  const by = q.by ?? "week";
  if (!STATS_GRANULARITIES.includes(by)) throw invalid(`by には ${STATS_GRANULARITIES.join(" か ")} を指定してください（${by}）`);
  const fmt = dateFormatter(q.tz);
  const tz = fmt.resolvedOptions().timeZone;
  const localDay = (timestamp: number) => parseDate(fmt.format(timestamp), "日付");
  const to = q.to === undefined ? localDay((q.now ?? new Date()).getTime()) : parseDate(q.to, "to ");
  let from = q.from === undefined
    ? (by === "day" ? to - 29 * DAY_MS : mondayOf(to) - 11 * 7 * DAY_MS)
    : parseDate(q.from, "from ");
  if (from > to) throw invalid(`from（${formatDate(from)}）は to（${formatDate(to)}）以前の日付にしてください`);
  if (by === "week") from = mondayOf(from);
  const step = by === "day" ? DAY_MS : 7 * DAY_MS;
  const count = Math.floor((to - from) / step) + 1;
  if (count > MAX_BUCKETS) throw invalid(`期間の数が多すぎます（${count}）。${MAX_BUCKETS} 以下になるよう範囲か by を変えてください`);
  const buckets = Array.from({ length: count }, (_, n) => ({
    start: formatDate(from + n * step),
    end: formatDate(Math.min(from + n * step + step - DAY_MS, to)),
  }));
  return {
    by,
    from: formatDate(from),
    to: formatDate(to),
    tz,
    buckets,
    bucketOf(timestamp) {
      const day = localDay(timestamp);
      return day < from || day > to ? -1 : Math.floor((day - from) / step);
    },
    since: new Date(from - 2 * DAY_MS).toISOString(),
    until: new Date(to + 3 * DAY_MS).toISOString(),
  };
}

// Workspace と Project の絞り込みを SQL の条件にする。i は issues の別名
export function issueScope(db: Database, q: StatsQuery): { where: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.workspace?.length) {
    const ids = q.workspace.map((key) => {
      const found = findWorkspace(db, key);
      if (!found) throw new NodError("NOT_FOUND", `Workspace ${key} はありません`);
      return found.id;
    });
    where.push(`i.workspace_id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }
  if (q.project !== undefined) {
    where.push("i.project_id = ?");
    params.push(resolveProject(db, q.project).id);
  }
  return { where: where.map((w) => ` AND ${w}`).join(""), params };
}

// 作業時間の終点。Reviews と同じく最後のレビュー提出、なければ完了時刻
export const WORK_END_SQL = `COALESCE((SELECT e.created_at FROM events e WHERE e.issue_id = i.id AND e.type = 'status_changed'
  AND json_extract(e.data, '$.to') = 'in_review' ORDER BY e.id DESC LIMIT 1), i.closed_at)`;

// 分単位の作業時間。Reviews の表示と同じく分未満を切り捨て、記録から求められなければ null
export function workMinutes(startedAt: string | null, endAt: string | null): number | null {
  const start = recordedTimestamp(startedAt);
  const end = recordedTimestamp(endAt);
  if (start === null || end === null || end < start) return null;
  return Math.floor((end - start) / 60_000);
}

export function summarizeWork(minutes: (number | null)[]): WorkTime {
  const measured = minutes.filter((m): m is number => m !== null).sort((a, b) => a - b);
  const mid = measured.length >> 1;
  return {
    measured: measured.length,
    unrecorded: minutes.length - measured.length,
    medianMinutes: measured.length === 0
      ? null
      : measured.length % 2 ? measured[mid]! : Math.floor((measured[mid - 1]! + measured[mid]!) / 2),
    totalMinutes: measured.reduce((sum, m) => sum + m, 0),
  };
}

// 期間ごとの完了数と作業時間。完了は status = 'done' の closed_at で数え、Project の Done 数と定義を揃える
export function completionStats(db: Database, q: StatsQuery = {}): CompletionStats {
  const frame = statsFrame(q);
  const scope = issueScope(db, q);
  const rows = db.query(`SELECT i.status, i.started_at, i.closed_at,
      CASE WHEN i.status = 'done' THEN ${WORK_END_SQL} END AS work_end
    FROM issues i
    WHERE i.status IN ('done', 'canceled') AND i.closed_at >= ? AND i.closed_at < ?${scope.where}`)
    .all(frame.since, frame.until, ...scope.params) as
    { status: "done" | "canceled"; started_at: string | null; closed_at: string; work_end: string | null }[];

  const acc = frame.buckets.map(() => ({ completed: 0, canceled: 0, minutes: [] as (number | null)[] }));
  for (const row of rows) {
    const closed = recordedTimestamp(row.closed_at);
    const n = closed === null ? -1 : frame.bucketOf(closed);
    if (n < 0) continue;
    const bucket = acc[n]!;
    if (row.status === "canceled") {
      bucket.canceled++;
      continue;
    }
    bucket.completed++;
    bucket.minutes.push(workMinutes(row.started_at, row.work_end));
  }
  return {
    by: frame.by,
    from: frame.from,
    to: frame.to,
    tz: frame.tz,
    buckets: frame.buckets.map((b, n) => ({
      ...b,
      completed: acc[n]!.completed,
      canceled: acc[n]!.canceled,
      work: summarizeWork(acc[n]!.minutes),
    })),
    totals: {
      completed: acc.reduce((s, b) => s + b.completed, 0),
      canceled: acc.reduce((s, b) => s + b.canceled, 0),
      work: summarizeWork(acc.flatMap((b) => b.minutes)),
    },
  };
}
