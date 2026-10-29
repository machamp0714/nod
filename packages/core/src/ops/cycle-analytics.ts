import type { Database } from "bun:sqlite";
import { type CycleAnalytics, type CycleBreakdownRow, type Status, STATUSES } from "../types";
import { addDays } from "./cycle-cadence";
import { type CycleClock, cycleToday, resolveCycle, summaryById } from "./cycles";
import { dateFormatter } from "./stats";

// Linear の Started に当たる status
export const STARTED_STATUSES: readonly Status[] = ["in_progress", "in_review"];

interface EventRow { type: string; data: string; created_at: string }
interface Snapshot { date: string; member: boolean; status: Status }
type Day = CycleAnalytics["burnup"][number];

const rate = (n: number, scope: number) => (scope === 0 ? null : n / scope);

// Cycle の分析（Linear の Cycle の右パネルと同じ内容）。数えるのは今所属している、アーカイブされていない Issue。
// 推移は events から各日の終わりの所属と status を再現する（スナップショットは持たない）。現在アーカイブ済みの Issue は全期間から除く
export function cycleAnalytics(db: Database, ref: string, clock: CycleClock = {}): CycleAnalytics {
  const { id } = resolveCycle(db, ref, clock);
  const today = cycleToday(clock);
  const cycle = summaryById(db, id, today);
  const live = "i.cycle_id = ? AND i.archived_at IS NULL";
  const statusRows = db.query(`SELECT i.status, count(*) AS n FROM issues i WHERE ${live} GROUP BY i.status`).all(id) as { status: Status; n: number }[];
  const count = (pick: (s: Status) => boolean) => statusRows.filter((r) => pick(r.status)).reduce((sum, r) => sum + r.n, 0);
  const scope = count((s) => s !== "canceled");
  const started = count((s) => STARTED_STATUSES.includes(s));
  const completed = count((s) => s === "done");
  const burnup = burnupOf(db, id, cycle.startDate, cycle.endDate < today ? cycle.endDate : today, clock);
  return {
    cycleId: id,
    scope,
    started,
    completed,
    startedRate: rate(started, scope),
    completedRate: rate(completed, scope),
    scopeAdded: burnup.length ? burnup.at(-1)!.scope - burnup[0]!.scope : 0,
    burnup,
    breakdown: {
      assignees: breakdown(db, id, "coalesce(i.assignee, '')", "coalesce(i.assignee, '担当なし')", ""),
      labels: breakdown(db, id, "l.label", "l.label", "JOIN issue_labels l ON l.issue_id = i.id"),
      projects: breakdown(db, id, "coalesce(p.id, '')", "coalesce(p.name, 'Project なし')", "LEFT JOIN projects p ON p.id = i.project_id"),
      workspaces: breakdown(db, id, "w.key", "w.key", "JOIN workspaces w ON w.id = i.workspace_id"),
    },
    statuses: STATUSES.map((status) => ({ status, count: statusRows.find((r) => r.status === status)?.n ?? 0 })),
  };
}

// 内訳の1種類。canceled を除いた total と done を、total の多い順・名前順で返す
function breakdown(db: Database, id: number, key: string, label: string, join: string): CycleBreakdownRow[] {
  return db
    .query(
      `SELECT CAST(${key} AS TEXT) AS key, ${label} AS label, count(*) AS total, sum(i.status = 'done') AS done
       FROM issues i ${join} WHERE i.cycle_id = ? AND i.archived_at IS NULL AND i.status <> 'canceled'
       GROUP BY 1, 2 ORDER BY total DESC, label`,
    )
    .all(id) as CycleBreakdownRow[];
}

function burnupOf(db: Database, id: number, start: string, last: string, clock: CycleClock): Day[] {
  if (last < start) return [];
  const localDate = dateFormatter(clock.tz);
  const issues = db
    .query(`SELECT i.id, i.cycle_id FROM issues i WHERE i.archived_at IS NULL AND (i.cycle_id = ? OR i.id IN (
       SELECT issue_id FROM events WHERE (type = 'created' AND json_extract(data, '$.cycle_id') = ?)
         OR (type = 'cycle_changed' AND (json_extract(data, '$.from_id') = ? OR json_extract(data, '$.to_id') = ?))))`)
    .all(id, id, id, id) as { id: number; cycle_id: number | null }[];
  const timelines = issues.map((issue) => timelineOf(db, issue, id, start, localDate));
  const days: Day[] = [];
  for (let date = start; date <= last; date = addDays(date, 1)) {
    const day: Day = { date, scope: 0, started: 0, completed: 0 };
    for (const snaps of timelines) {
      const s = snaps.filter((x) => x.date <= date).at(-1);
      if (!s?.member || s.status === "canceled") continue;
      day.scope++;
      if (s.status === "done") day.completed++;
      else if (STARTED_STATUSES.includes(s.status)) day.started++;
    }
    days.push(day);
  }
  return days;
}

// 1件の Issue の、日付ごとの所属と status。ID のない古い記録しかなく今は所属している Issue は、開始日から所属とみなす
function timelineOf(db: Database, issue: { id: number; cycle_id: number | null }, id: number, start: string, localDate: Intl.DateTimeFormat): Snapshot[] {
  const events = db
    .query("SELECT type, data, created_at FROM events WHERE issue_id = ? AND type IN ('created', 'cycle_changed', 'status_changed') ORDER BY id")
    .all(issue.id) as EventRow[];
  const snaps: Snapshot[] = [];
  let member = false;
  let status: Status = "todo";
  let knowsMembership = false;
  for (const e of events) {
    const data = JSON.parse(e.data) as Record<string, unknown>;
    if (e.type === "created") {
      status = data.status as Status;
      member = data.cycle_id === id;
      knowsMembership ||= "cycle_id" in data;
    } else if (e.type === "cycle_changed" && "to_id" in data) {
      member = data.to_id === id;
      knowsMembership = true;
    } else if (e.type === "status_changed") {
      status = data.to as Status;
    }
    snaps.push({ date: localDate.format(new Date(e.created_at)), member, status });
  }
  if (issue.cycle_id === id && !knowsMembership) {
    return [{ date: start, member: true, status: snaps.filter((s) => s.date <= start).at(-1)?.status ?? snaps[0]?.status ?? status }, ...snaps.map((s) => ({ ...s, member: true }))].sort((x, y) => x.date.localeCompare(y.date));
  }
  return snaps;
}
