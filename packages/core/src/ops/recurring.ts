import type { Database } from "bun:sqlite";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { formatIssueId } from "../issue-query";
import {
  RECURRENCE_CADENCES,
  type RecurrenceCadence,
  type RecurringIssue,
  type RecurringRun,
  type RecurringRunItem,
  type Workspace,
} from "../types";
import { insertIssue, requireText, validatePriority } from "./issues";
import { resolveProject } from "./projects";
import { dateFormatter } from "./stats";
import { getTemplate } from "./templates";
import { findWorkspace } from "./workspaces";

// 常駐はしない。人が nod recurring run（web は「今すぐ実行」）で1回ずつ起票する。
// 前回の起票から複数の発生日が過ぎていても、作るのは最新の1件だけで、残りは飛ばした数として返す
const DAY_MS = 86_400_000;
const MIN_START_DATE = "2000-01-01";

export interface RecurringIssueInput {
  title: string;
  description?: string | null;
  template?: string | null;
  projectRef?: string | null;
  labels?: string[];
  priority?: number;
  assignee?: string | null;
  cadence: RecurrenceCadence;
  weekday?: number | null;
  monthDay?: number | null;
  startDate: string;
  timeZone?: string;
  enabled?: boolean;
}

export type RecurringIssuePatch = Partial<RecurringIssueInput>;

interface RecurringRow {
  id: number;
  workspace_id: number;
  title: string;
  description: string | null;
  template: string | null;
  project_id: number | null;
  project_name: string | null;
  labels: string;
  priority: number;
  assignee: string | null;
  cadence: RecurrenceCadence;
  weekday: number | null;
  month_day: number | null;
  start_date: string;
  time_zone: string;
  enabled: number;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  last_occurrence: string | null;
  last_issue_number: number | null;
}

const SELECT = `SELECT r.*, p.name AS project_name,
    (SELECT max(o.occurrence_date) FROM recurring_issue_occurrences o WHERE o.recurring_id = r.id) AS last_occurrence,
    (SELECT i.number FROM recurring_issue_occurrences o JOIN issues i ON i.id = o.issue_id
      WHERE o.recurring_id = r.id ORDER BY o.occurrence_date DESC LIMIT 1) AS last_issue_number
  FROM recurring_issues r LEFT JOIN projects p ON p.id = r.project_id`;

function requireWorkspace(db: Database, keyOrPath: string): Workspace {
  const workspace = findWorkspace(db, keyOrPath);
  if (!workspace) throw new NodError("NOT_FOUND", `Workspace ${keyOrPath} は登録されていません`);
  return workspace;
}

function requireHuman(ctx: OpCtx, what: string): void {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", `LLM は定期Issueを${what}できません。me に依頼してください（--dry-run での確認はできます）`);
  }
}

function invalid(message: string): NodError {
  return new NodError("INVALID_ARGS", message);
}

// 暦日 YYYY-MM-DD と、1970-01-01 からの日数を相互に変換する
function dayOf(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return formatDay(at / DAY_MS) === date ? at / DAY_MS : null;
}

function formatDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function todayIn(timeZone: string, at: Date): number {
  return dayOf(dateFormatter(timeZone).format(at))!;
}

function daysInMonth(date: Date): number {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

interface Rule {
  cadence: RecurrenceCadence;
  weekday: number | null;
  monthDay: number | null;
}

function matches(rule: Rule, day: number): boolean {
  if (rule.cadence === "daily") return true;
  const date = new Date(day * DAY_MS);
  if (rule.cadence === "weekly") return date.getUTCDay() === rule.weekday;
  return date.getUTCDate() === Math.min(rule.monthDay!, daysInMonth(date));
}

// from〜to（両端を含む）の発生日。多くても開始日からの日数ぶんしか回らない
function occurrences(rule: Rule, from: number, to: number): number[] {
  const days: number[] = [];
  for (let d = from; d <= to; d++) if (matches(rule, d)) days.push(d);
  return days;
}

function nextOccurrence(rule: Rule, from: number): number {
  let d = from;
  while (!matches(rule, d)) d++;
  return d;
}

function toRecurring(workspace: Workspace, row: RecurringRow, at: Date): RecurringIssue {
  const rule: Rule = { cadence: row.cadence, weekday: row.weekday, monthDay: row.month_day };
  const lastDay = row.last_occurrence === null ? null : dayOf(row.last_occurrence);
  const from = Math.max(dayOf(row.start_date)!, lastDay === null ? -Infinity : lastDay + 1, todayIn(row.time_zone, at));
  return {
    id: row.id,
    workspaceKey: workspace.key,
    title: row.title,
    description: row.description,
    template: row.template,
    project: row.project_name,
    labels: JSON.parse(row.labels) as string[],
    priority: row.priority,
    assignee: row.assignee,
    cadence: row.cadence,
    weekday: row.weekday,
    monthDay: row.month_day,
    startDate: row.start_date,
    timeZone: row.time_zone,
    enabled: row.enabled === 1,
    lastOccurrence: row.last_occurrence,
    lastIssueId: row.last_issue_number === null ? null : formatIssueId(workspace.key, row.last_issue_number),
    nextOccurrence: row.enabled === 1 ? formatDay(nextOccurrence(rule, from)) : null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

function rows(db: Database, workspace: Workspace): RecurringRow[] {
  return db.query(`${SELECT} WHERE r.workspace_id = ? ORDER BY r.id`).all(workspace.id) as RecurringRow[];
}

function requireRow(db: Database, workspace: Workspace, id: number): RecurringRow {
  const row = db.query(`${SELECT} WHERE r.workspace_id = ? AND r.id = ?`).get(workspace.id, id) as RecurringRow | null;
  if (!row) throw new NodError("NOT_FOUND", `${workspace.key} に定期Issue ${id} はありません。nod recurring list で確かめてください`);
  return row;
}

export function listRecurringIssues(db: Database, keyOrPath: string, opts: { now?: Date } = {}): RecurringIssue[] {
  const workspace = requireWorkspace(db, keyOrPath);
  return rows(db, workspace).map((r) => toRecurring(workspace, r, opts.now ?? new Date()));
}

export function getRecurringIssue(db: Database, keyOrPath: string, id: number, opts: { now?: Date } = {}): RecurringIssue {
  const workspace = requireWorkspace(db, keyOrPath);
  return toRecurring(workspace, requireRow(db, workspace, id), opts.now ?? new Date());
}

interface Normalized {
  title: string;
  description: string | null;
  template: string | null;
  projectId: number | null;
  labels: string[];
  priority: number;
  assignee: string | null;
  cadence: RecurrenceCadence;
  weekday: number | null;
  monthDay: number | null;
  startDate: string;
  timeZone: string;
  enabled: boolean;
}

// 保存する値をそろえて検証する。周期で使わない曜日・日は null にする
function normalize(db: Database, input: Normalized & { projectRef?: string | null }): Normalized {
  requireText(input.title, "タイトル");
  if (!RECURRENCE_CADENCES.includes(input.cadence)) {
    throw invalid(`周期は ${RECURRENCE_CADENCES.join(" / ")} のどれかで指定してください（${input.cadence}）`);
  }
  if (input.cadence === "weekly") {
    if (input.weekday === null || !Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) {
      throw invalid("毎週の定期Issueには曜日（0 = 日曜 〜 6 = 土曜）を指定してください");
    }
  } else if (input.weekday !== null) {
    throw invalid("曜日は毎週（weekly）の定期Issueにだけ指定できます");
  }
  if (input.cadence === "monthly") {
    if (input.monthDay === null || !Number.isInteger(input.monthDay) || input.monthDay < 1 || input.monthDay > 31) {
      throw invalid("毎月の定期Issueには日（1〜31。その日が無い月は月末）を指定してください");
    }
  } else if (input.monthDay !== null) {
    throw invalid("日は毎月（monthly）の定期Issueにだけ指定できます");
  }
  if (dayOf(input.startDate) === null || input.startDate < MIN_START_DATE) {
    throw invalid(`開始日 ${input.startDate} は使えません（${MIN_START_DATE} 以降の YYYY-MM-DD で指定してください）`);
  }
  dateFormatter(input.timeZone);
  validatePriority(input.priority);
  if (input.template !== null && input.description !== null) {
    throw invalid("本文とテンプレートは同時に指定できません");
  }
  if (input.template !== null) getTemplate(db, input.template);
  const labels = [...new Set(input.labels.map((l) => l.trim()))];
  if (labels.some((l) => !l)) throw invalid("空のラベルは指定できません");
  const assignee = input.assignee === null ? null : input.assignee.trim() || null;
  return { ...input, labels, assignee };
}

export function addRecurringIssue(ctx: OpCtx, keyOrPath: string, input: RecurringIssueInput, opts: { now?: Date } = {}): RecurringIssue {
  requireHuman(ctx, "登録");
  return tx(ctx.db, () => {
    const workspace = requireWorkspace(ctx.db, keyOrPath);
    const project = input.projectRef ? resolveProject(ctx.db, input.projectRef) : null;
    const v = normalize(ctx.db, {
      title: input.title,
      description: input.description ?? null,
      template: input.template ?? null,
      projectId: project?.id ?? null,
      labels: input.labels ?? [],
      priority: input.priority ?? 0,
      assignee: input.assignee ?? null,
      cadence: input.cadence,
      weekday: input.weekday ?? null,
      monthDay: input.monthDay ?? null,
      startDate: input.startDate,
      timeZone: input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      enabled: input.enabled ?? true,
    });
    const ts = now();
    const { lastInsertRowid } = ctx.db
      .query(
        `INSERT INTO recurring_issues (workspace_id, title, description, template, project_id, labels, priority, assignee,
           cadence, weekday, month_day, start_date, time_zone, enabled, created_by, created_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspace.id, v.title, v.description, v.template, v.projectId, JSON.stringify(v.labels), v.priority, v.assignee,
        v.cadence, v.weekday, v.monthDay, v.startDate, v.timeZone, v.enabled ? 1 : 0, ctx.actor, ts, ctx.actor, ts,
      );
    return toRecurring(workspace, requireRow(ctx.db, workspace, Number(lastInsertRowid)), opts.now ?? new Date());
  });
}

// 渡した項目だけを変える。周期を変えたときに使わなくなる曜日・日は消す。本文とテンプレートは片方を渡すともう片方を消す
export function updateRecurringIssue(
  ctx: OpCtx,
  keyOrPath: string,
  id: number,
  patch: RecurringIssuePatch,
  opts: { now?: Date } = {},
): RecurringIssue {
  requireHuman(ctx, "変更");
  return tx(ctx.db, () => {
    const workspace = requireWorkspace(ctx.db, keyOrPath);
    const row = requireRow(ctx.db, workspace, id);
    const cadence = patch.cadence ?? row.cadence;
    const cadenceChanged = patch.cadence !== undefined && patch.cadence !== row.cadence;
    let description = patch.description !== undefined ? patch.description : row.description;
    let template = patch.template !== undefined ? patch.template : row.template;
    if (patch.description != null && patch.template === undefined) template = null;
    if (patch.template != null && patch.description === undefined) description = null;
    const projectId =
      patch.projectRef === undefined ? row.project_id : patch.projectRef ? resolveProject(ctx.db, patch.projectRef).id : null;
    const v = normalize(ctx.db, {
      title: patch.title ?? row.title,
      description,
      template,
      projectId,
      labels: patch.labels ?? (JSON.parse(row.labels) as string[]),
      priority: patch.priority ?? row.priority,
      assignee: patch.assignee !== undefined ? patch.assignee : row.assignee,
      cadence,
      weekday: patch.weekday !== undefined ? patch.weekday : cadenceChanged ? null : row.weekday,
      monthDay: patch.monthDay !== undefined ? patch.monthDay : cadenceChanged ? null : row.month_day,
      startDate: patch.startDate ?? row.start_date,
      timeZone: patch.timeZone ?? row.time_zone,
      enabled: patch.enabled ?? row.enabled === 1,
    });
    ctx.db
      .query(
        `UPDATE recurring_issues SET title = ?, description = ?, template = ?, project_id = ?, labels = ?, priority = ?, assignee = ?,
           cadence = ?, weekday = ?, month_day = ?, start_date = ?, time_zone = ?, enabled = ?, updated_by = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        v.title, v.description, v.template, v.projectId, JSON.stringify(v.labels), v.priority, v.assignee,
        v.cadence, v.weekday, v.monthDay, v.startDate, v.timeZone, v.enabled ? 1 : 0, ctx.actor, now(), row.id,
      );
    return toRecurring(workspace, requireRow(ctx.db, workspace, row.id), opts.now ?? new Date());
  });
}

// 定義だけを消す。起票済みの Issue と、その created event の recurring_id は残す
export function removeRecurringIssue(ctx: OpCtx, keyOrPath: string, id: number): RecurringIssue {
  requireHuman(ctx, "削除");
  return tx(ctx.db, () => {
    const workspace = requireWorkspace(ctx.db, keyOrPath);
    const removed = toRecurring(workspace, requireRow(ctx.db, workspace, id), new Date());
    ctx.db.query("DELETE FROM recurring_issues WHERE id = ?").run(id);
    return removed;
  });
}

type RunOutcome = { item: RecurringRunItem; failed?: never } | { failed: RecurringRun["failed"][number]; item?: never };

// 起票すべき最新の発生日と、それより前に飛ばす発生日の数。無ければ null
function dueOccurrence(row: RecurringRow, at: Date): { day: number; skipped: number } | null {
  const rule: Rule = { cadence: row.cadence, weekday: row.weekday, monthDay: row.month_day };
  const lastDay = row.last_occurrence === null ? null : dayOf(row.last_occurrence);
  const from = Math.max(dayOf(row.start_date)!, lastDay === null ? -Infinity : lastDay + 1);
  const due = occurrences(rule, from, todayIn(row.time_zone, at));
  return due.length ? { day: due[due.length - 1]!, skipped: due.length - 1 } : null;
}

// 有効な定期Issueのうち、発生日が来ているものを1件ずつ起票する。
// 起票は通常の起票と同じ経路（人なら todo）で行い、created event に recurring_id と発生日を残す。
// テンプレートが消えているなどで起票できないものは failed に入れて、他の定期Issueは続ける
export function runRecurringIssues(
  ctx: OpCtx,
  keyOrPath: string,
  opts: { dryRun?: boolean; now?: Date } = {},
): RecurringRun {
  const dryRun = opts.dryRun ?? false;
  if (!dryRun) requireHuman(ctx, "実行");
  const at = opts.now ?? new Date();
  const workspace = requireWorkspace(ctx.db, keyOrPath);
  const result: RecurringRun = { workspaceKey: workspace.key, dryRun, evaluatedAt: at.toISOString(), items: [], failed: [] };
  for (const { id } of rows(ctx.db, workspace).filter((r) => r.enabled === 1)) {
    const outcome = tx(ctx.db, (): RunOutcome | null => {
      // 同時に実行されても同じ発生日を二重に作らないよう、transaction の中で読み直す
      const row = requireRow(ctx.db, workspace, id);
      const due = dueOccurrence(row, at);
      if (!due) return null;
      const base = { recurringId: row.id, title: row.title, occurrence: formatDay(due.day), skipped: due.skipped };
      let description = row.description;
      if (row.template !== null) {
        try {
          description = getTemplate(ctx.db, row.template).body;
        } catch (e) {
          if (!(e instanceof NodError)) throw e;
          return { failed: { recurringId: row.id, title: row.title, occurrence: base.occurrence, message: e.message } };
        }
      }
      if (dryRun) return { item: { ...base, issueId: null } };
      const issue = insertIssue(ctx, {
        workspaceId: workspace.id,
        title: row.title,
        description,
        priority: row.priority,
        estimate: null,
        dueDate: null,
        parentId: null,
        projectId: row.project_id,
        labels: JSON.parse(row.labels) as string[],
        assignee: row.assignee,
        origin: { recurring_id: row.id, occurrence: base.occurrence },
      });
      const { id: issueRowId } = ctx.db
        .query("SELECT id FROM issues WHERE workspace_id = ? AND number = ?")
        .get(workspace.id, issue.number) as { id: number };
      ctx.db
        .query("INSERT INTO recurring_issue_occurrences (recurring_id, occurrence_date, issue_id, created_at) VALUES (?, ?, ?, ?)")
        .run(row.id, base.occurrence, issueRowId, now());
      return { item: { ...base, issueId: issue.id } };
    });
    if (outcome?.item) result.items.push(outcome.item);
    if (outcome?.failed) result.failed.push(outcome.failed);
  }
  return result;
}
