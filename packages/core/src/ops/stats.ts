import type { Database } from "bun:sqlite";
import { HUMAN_ACTOR } from "../ctx";
import { NodError } from "../errors";
import { recordedTimestamp } from "../recorded-time";
import { findWorkspace } from "./workspaces";
import { isNoneRef } from "../none-ref";
import { resolveCycleInScope } from "./cycles";
import { resolveMilestone } from "./milestones";
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
  milestone?: string; // Milestone の ID か none（Milestone のない Issue）。名前は project を指定したときだけ（その Project の中で引く）
  cycle?: string; // Cycle の ID か none（Cycle のない Issue）。名前・current は Workspace を1つに絞ったときだけ（current は tz の今日で決める）
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

const QUERY_KEYS = ["by", "from", "to", "tz", "workspace", "project", "milestone", "cycle"];

// API のクエリパラメータを StatsQuery にする。workspace だけは複数指定できる
export function statsQueryFromParams(params: URLSearchParams): StatsQuery {
  const unknownKeys = [...new Set(params.keys())].filter((k) => !QUERY_KEYS.includes(k));
  if (unknownKeys.length) throw invalid(`${unknownKeys.join(", ")} は受け付けません（使えるもの: ${QUERY_KEYS.join(", ")}）`);
  const q: StatsQuery = {};
  for (const key of ["by", "from", "to", "tz", "project", "milestone", "cycle"] as const) {
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

// IANA の名前だけを受け付ける。Intl は +09:00 のようなオフセットも通すが、夏時間を表せないため断る
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+\-/]*$/;

export function dateFormatter(tz: string | undefined): Intl.DateTimeFormat {
  const rejected = invalid(`タイムゾーン ${tz} はありません。Asia/Tokyo のような IANA の名前で指定してください`);
  if (tz !== undefined && !IANA_NAME.test(tz)) throw rejected;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    throw rejected;
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

// Workspace・Project・Milestone・Cycle の絞り込みを SQL の条件にする。i は issues の別名
export function issueScope(
  db: Database,
  q: Pick<StatsQuery, "workspace" | "project" | "milestone" | "cycle" | "tz" | "now">,
): { where: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  let workspaceIds: number[] | undefined;
  if (q.workspace?.length) {
    const ids = q.workspace.map((key) => {
      const found = findWorkspace(db, key);
      if (!found) throw new NodError("NOT_FOUND", `Workspace ${key} はありません`);
      return found.id;
    });
    workspaceIds = [...new Set(ids)];
    where.push(`i.workspace_id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }
  let projectId: number | undefined;
  if (q.project !== undefined) {
    projectId = resolveProject(db, q.project).id;
    where.push("i.project_id = ?");
    params.push(projectId);
  }
  if (q.milestone !== undefined) {
    if (!q.milestone.trim()) throw invalid("Milestone を指定してください");
    if (isNoneRef(q.milestone)) where.push("i.milestone_id IS NULL");
    else {
      if (projectId === undefined && !/^\d+$/.test(q.milestone)) {
        throw invalid(`Milestone を名前（${q.milestone}）で指すときは Project も指定してください。名前は Project の中でだけ一意です`);
      }
      const milestone = resolveMilestone(db, q.milestone, projectId);
      if (projectId !== undefined && milestone.project_id !== projectId) {
        throw invalid(`Milestone ${q.milestone}（${milestone.name}）は指定した Project のものではありません`);
      }
      where.push("i.milestone_id = ?");
      params.push(milestone.id);
    }
  }
  if (q.cycle !== undefined) {
    if (!q.cycle.trim()) throw invalid("Cycle を指定してください");
    if (isNoneRef(q.cycle)) where.push("i.cycle_id IS NULL");
    else {
      where.push("i.cycle_id = ?");
      params.push(resolveCycleInScope(db, q.cycle, workspaceIds, { tz: q.tz, now: q.now }));
    }
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

// 取り込んだ時点で閉じていた Issue（#77）。created の event が取り込み由来で status が done・canceled で、その後に状態の遷移がない。
// nod で完了・キャンセルしたものではないので完了数に数えない。取り込み後に開き直して閉じたものは数える。i は issues の別名
export const CLOSED_ON_IMPORT_SQL = `(EXISTS (SELECT 1 FROM events c WHERE c.issue_id = i.id AND c.type = 'created'
    AND json_extract(c.data, '$.imported_from') IS NOT NULL AND json_extract(c.data, '$.status') IN ('done', 'canceled'))
  AND NOT EXISTS (SELECT 1 FROM events s WHERE s.issue_id = i.id AND s.type = 'status_changed'))`;

// 期間ごとの完了数と作業時間。完了は status = 'done' の closed_at で数え、Project の Done 数と定義を揃える
export function completionStats(db: Database, q: StatsQuery = {}): CompletionStats {
  const frame = statsFrame(q);
  const scope = issueScope(db, q);
  const rows = db.query(`SELECT i.status, i.started_at, i.closed_at,
      CASE WHEN i.status = 'done' THEN ${WORK_END_SQL} END AS work_end
    FROM issues i
    WHERE i.status IN ('done', 'canceled') AND i.closed_at >= ? AND i.closed_at < ? AND NOT ${CLOSED_ON_IMPORT_SQL}${scope.where}`)
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

export interface LlmBucket {
  start: string;
  end: string;
  assigned: number; // その LLM が担当になった回数（自分で取った・人が割り当てたの両方）
  submitted: number; // その LLM がレビューに回した回数
  completed: number; // その LLM に帰属する done の件数
  work: WorkTime;
}

export interface LlmWorkload {
  name: string;
  buckets: LlmBucket[];
  totals: Omit<LlmBucket, "start" | "end">;
}

export interface LlmStats extends StatsRange {
  buckets: { start: string; end: string }[];
  llms: LlmWorkload[];
}

// LLM が担当になった assignee_changed の to。人（me）と担当なしは除く。alias は events の別名
export function llmAssignee(alias: string): string {
  return `json_extract(${alias}.data, '$.to') IS NOT NULL AND json_extract(${alias}.data, '$.to') <> '${HUMAN_ACTOR}'`;
}
const LLM_ASSIGNEE = llmAssignee("e");

// LLM ごとの作業量。LLM は done にできないため、完了は closed_at 以前で最後に LLM を担当にした記録へ帰属させる
export function llmStats(db: Database, q: StatsQuery = {}): LlmStats {
  const frame = statsFrame(q);
  const scope = issueScope(db, q);
  type Acc = { assigned: number; submitted: number; completed: number; minutes: (number | null)[] };
  const perLlm = new Map<string, Acc[]>();
  const accOf = (name: string) => {
    let acc = perLlm.get(name);
    if (!acc) perLlm.set(name, (acc = frame.buckets.map(() => ({ assigned: 0, submitted: 0, completed: 0, minutes: [] }))));
    return acc;
  };
  const bucketAt = (at: string) => {
    const t = recordedTimestamp(at);
    return t === null ? -1 : frame.bucketOf(t);
  };

  const events = db.query(`SELECT e.type, e.actor, json_extract(e.data, '$.to') AS "to", e.created_at
    FROM events e JOIN issues i ON i.id = e.issue_id
    WHERE ((e.type = 'assignee_changed' AND ${LLM_ASSIGNEE})
      OR (e.type = 'status_changed' AND e.actor <> ? AND json_extract(e.data, '$.to') = 'in_review'))
      AND e.created_at >= ? AND e.created_at < ?${scope.where}`)
    .all(HUMAN_ACTOR, frame.since, frame.until, ...scope.params) as
    { type: string; actor: string; to: string; created_at: string }[];
  for (const e of events) {
    const n = bucketAt(e.created_at);
    if (n < 0) continue;
    if (e.type === "assignee_changed") accOf(e.to)[n]!.assigned++;
    else accOf(e.actor)[n]!.submitted++;
  }

  const done = db.query(`SELECT i.started_at, i.closed_at, ${WORK_END_SQL} AS work_end,
      (SELECT json_extract(e.data, '$.to') FROM events e WHERE e.issue_id = i.id AND e.type = 'assignee_changed'
        AND ${LLM_ASSIGNEE} AND e.created_at <= i.closed_at ORDER BY e.id DESC LIMIT 1) AS llm
    FROM issues i
    WHERE i.status = 'done' AND i.closed_at >= ? AND i.closed_at < ?${scope.where}`)
    .all(frame.since, frame.until, ...scope.params) as
    { started_at: string | null; closed_at: string; work_end: string | null; llm: string | null }[];
  for (const row of done) {
    if (row.llm === null) continue;
    const n = bucketAt(row.closed_at);
    if (n < 0) continue;
    const bucket = accOf(row.llm)[n]!;
    bucket.completed++;
    bucket.minutes.push(workMinutes(row.started_at, row.work_end));
  }

  const sum = (acc: Acc[], key: "assigned" | "submitted" | "completed") => acc.reduce((s, b) => s + b[key], 0);
  const llms = [...perLlm].map(([name, acc]): LlmWorkload => ({
    name,
    buckets: frame.buckets.map((b, n) => ({
      ...b,
      assigned: acc[n]!.assigned,
      submitted: acc[n]!.submitted,
      completed: acc[n]!.completed,
      work: summarizeWork(acc[n]!.minutes),
    })),
    totals: {
      assigned: sum(acc, "assigned"),
      submitted: sum(acc, "submitted"),
      completed: sum(acc, "completed"),
      work: summarizeWork(acc.flatMap((b) => b.minutes)),
    },
  }));
  llms.sort((a, b) => b.totals.completed - a.totals.completed || b.totals.assigned - a.totals.assigned
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { by: frame.by, from: frame.from, to: frame.to, tz: frame.tz, buckets: frame.buckets, llms };
}
