import type { Database } from "bun:sqlite";
import { latestActivity } from "../activity";
import { HUMAN_ACTOR, isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { findWritableIssueRow, formatIssueId, type IssueRow } from "../issue-query";
import { setColumn } from "../mutate";
import { recordedTimestamp } from "../recorded-time";
import type {
  AutomationCandidate,
  AutomationKind,
  AutomationRuleResult,
  AutomationRun,
  AutomationSettings,
  Status,
  Workspace,
} from "../types";
import { archiveIssue } from "./issues";
import { findWorkspace } from "./workspaces";

// 常駐はしない。人が CLI・Web から明示的に1回ずつ実行する（dry-run は誰でも、実行と設定変更は me だけ）
export const AUTOMATION_DAYS_MAX = 3650;
export const AUTOMATION_LIMIT_DEFAULT = 50;
export const AUTOMATION_LIMIT_MAX = 500;

const DAY_MS = 86_400_000;
// Triage（人の判断待ち）と in_review（レビュー待ちの成果）は閉じない
const CLOSE_STATUSES: Status[] = ["backlog", "todo", "in_progress", "needs_clarification"];
// 未完了で未アーカイブの子を持つ親は、どちらのルールでも対象外
const NO_OPEN_CHILD = `NOT EXISTS (SELECT 1 FROM issues c WHERE c.parent_id = i.id AND c.archived_at IS NULL
  AND c.status NOT IN ('done', 'canceled'))`;

interface SettingsRow {
  auto_close_days: number | null;
  auto_archive_days: number | null;
  automation_updated_at: string | null;
  automation_updated_by: string | null;
}

interface CandidateRow {
  id: number;
  number: number;
  title: string;
  status: Status;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  snoozed_until: string | null;
}

function requireWorkspace(db: Database, keyOrPath: string): Workspace {
  const workspace = findWorkspace(db, keyOrPath);
  if (!workspace) throw new NodError("NOT_FOUND", `Workspace ${keyOrPath} は登録されていません`);
  return workspace;
}

function validateDays(days: number | null | undefined, label: string): void {
  if (days === null || days === undefined) return;
  if (!Number.isSafeInteger(days) || days < 1 || days > AUTOMATION_DAYS_MAX) {
    throw new NodError("INVALID_ARGS", `${label}は 1〜${AUTOMATION_DAYS_MAX} の整数（日数）で指定してください`);
  }
}

function readSettings(db: Database, workspace: Workspace): AutomationSettings {
  const row = db
    .query("SELECT auto_close_days, auto_archive_days, automation_updated_at, automation_updated_by FROM workspaces WHERE id = ?")
    .get(workspace.id) as SettingsRow;
  return {
    workspaceKey: workspace.key,
    closeAfterDays: row.auto_close_days,
    archiveAfterDays: row.auto_archive_days,
    updatedAt: row.automation_updated_at,
    updatedBy: row.automation_updated_by,
  };
}

export function getAutomationSettings(db: Database, keyOrPath: string): AutomationSettings {
  return readSettings(db, requireWorkspace(db, keyOrPath));
}

// 渡した項目だけを変える。null はそのルールを無効にする
export function setAutomationSettings(
  ctx: OpCtx,
  keyOrPath: string,
  input: { closeAfterDays?: number | null; archiveAfterDays?: number | null },
): AutomationSettings {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は自動化の設定を変えられません。変更は me に依頼してください");
  }
  validateDays(input.closeAfterDays, "自動クローズの日数");
  validateDays(input.archiveAfterDays, "自動アーカイブの日数");
  return tx(ctx.db, () => {
    const workspace = requireWorkspace(ctx.db, keyOrPath);
    const current = readSettings(ctx.db, workspace);
    ctx.db
      .query(
        "UPDATE workspaces SET auto_close_days = ?, auto_archive_days = ?, automation_updated_at = ?, automation_updated_by = ? WHERE id = ?",
      )
      .run(
        input.closeAfterDays !== undefined ? input.closeAfterDays : current.closeAfterDays,
        input.archiveAfterDays !== undefined ? input.archiveAfterDays : current.archiveAfterDays,
        now(),
        ctx.actor,
        workspace.id,
      );
    return readSettings(ctx.db, workspace);
  });
}

export function closeReasonOf(days: number): string {
  return `自動クローズ（${days}日間更新なし）`;
}

export function archiveReasonOf(days: number): string {
  return `自動アーカイブ（完了から${days}日経過）`;
}

interface Found {
  candidate: AutomationCandidate;
  at: number;
  number: number;
}

function sorted(found: Found[]): Found[] {
  return found.sort((a, b) => a.at - b.at || a.number - b.number);
}

function candidateOf(workspace: Workspace, row: CandidateRow, at: number, current: number): Found {
  return {
    candidate: {
      id: formatIssueId(workspace.key, row.number),
      title: row.title,
      status: row.status,
      since: new Date(at).toISOString(),
      elapsedDays: Math.floor((current - at) / DAY_MS),
    },
    at,
    number: row.number,
  };
}

// 最後の活動から days 日以上たった未完了の Issue。委任中（担当が me 以外）とスヌーズ中は除く
function closeCandidates(db: Database, workspace: Workspace, days: number, current: number): Found[] {
  const rows = db
    .query(`SELECT i.id, i.number, i.title, i.status, i.created_at, i.updated_at, i.closed_at, i.snoozed_until FROM issues i
      WHERE i.workspace_id = ? AND i.archived_at IS NULL
        AND i.status IN (${CLOSE_STATUSES.map(() => "?").join(", ")})
        AND (i.assignee IS NULL OR i.assignee = ?)
        AND ${NO_OPEN_CHILD}`)
    .all(workspace.id, ...CLOSE_STATUSES, HUMAN_ACTOR) as CandidateRow[];
  const found: Found[] = [];
  for (const row of rows) {
    const snoozedUntil = recordedTimestamp(row.snoozed_until);
    if (snoozedUntil !== null && snoozedUntil > current) continue;
    const latest = latestActivity(db, row.id, row.created_at, row.updated_at);
    if (latest === null || current - latest < days * DAY_MS) continue;
    found.push(candidateOf(workspace, row, latest, current));
  }
  return sorted(found);
}

// 完了（done・canceled）から days 日以上たった、未アーカイブの Issue
function archiveCandidates(db: Database, workspace: Workspace, days: number, current: number): Found[] {
  const rows = db
    .query(`SELECT i.id, i.number, i.title, i.status, i.created_at, i.updated_at, i.closed_at, i.snoozed_until FROM issues i
      WHERE i.workspace_id = ? AND i.archived_at IS NULL AND i.status IN ('done', 'canceled') AND ${NO_OPEN_CHILD}`)
    .all(workspace.id) as CandidateRow[];
  const found: Found[] = [];
  for (const row of rows) {
    const closedAt = recordedTimestamp(row.closed_at);
    if (closedAt === null || current - closedAt < days * DAY_MS) continue;
    found.push(candidateOf(workspace, row, closedAt, current));
  }
  return sorted(found);
}

// 自動クローズ1件。実行時にも対象の状態を確かめ、すでに外れていれば何もしない
function closeOne(ctx: OpCtx, ref: string, days: number): boolean {
  return tx(ctx.db, () => {
    const row: IssueRow = findWritableIssueRow(ctx.db, ref);
    if (!CLOSE_STATUSES.includes(row.status)) return false;
    const reason = closeReasonOf(days);
    setColumn(ctx, row, "close_reason", reason);
    setColumn(ctx, row, "status", "canceled", { reason, automation: "auto_close" });
    setColumn(ctx, row, "agent_state", null);
    return true;
  });
}

function archiveOne(ctx: OpCtx, ref: string, days: number): boolean {
  const issue = archiveIssue(ctx, ref, { reason: archiveReasonOf(days), automation: "auto_archive" });
  return issue.archivedAt !== null;
}

function applyRule(
  ctx: OpCtx,
  kind: AutomationKind,
  days: number | null,
  dryRun: boolean,
  limit: number,
  find: (days: number) => Found[],
  act: (ref: string, days: number) => boolean,
): AutomationRuleResult {
  const result: AutomationRuleResult = {
    kind,
    days,
    enabled: days !== null,
    total: 0,
    candidates: [],
    processed: [],
    failed: [],
    remaining: 0,
  };
  if (days === null) return result;
  const found = find(days);
  result.total = found.length;
  result.candidates = found.slice(0, limit).map((f) => f.candidate);
  result.remaining = found.length - result.candidates.length;
  if (dryRun) return result;
  // 1件ごとに確定し、途中で失敗しても残りを続ける
  for (const candidate of result.candidates) {
    try {
      if (act(candidate.id, days)) result.processed.push(candidate.id);
    } catch (e) {
      result.failed.push({ id: candidate.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

// 有効なルールを1回だけ評価・実行する。自動クローズを先に行い、その回で閉じた Issue はアーカイブしない
export function runAutomation(
  ctx: OpCtx,
  keyOrPath: string,
  opts: { dryRun?: boolean; limit?: number; evaluatedAt?: string } = {},
): AutomationRun {
  const dryRun = opts.dryRun ?? false;
  if (!dryRun && isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は自動化を実行できません（--dry-run での確認はできます）。実行は me に依頼してください");
  }
  const limit = opts.limit ?? AUTOMATION_LIMIT_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > AUTOMATION_LIMIT_MAX) {
    throw new NodError("INVALID_ARGS", `--limit は 1〜${AUTOMATION_LIMIT_MAX} の整数で指定してください`);
  }
  const evaluatedAt = opts.evaluatedAt ?? now();
  const current = recordedTimestamp(evaluatedAt);
  if (current === null) throw new NodError("INVALID_ARGS", "自動化の基準日時が正しくありません");
  const workspace = requireWorkspace(ctx.db, keyOrPath);
  const settings = readSettings(ctx.db, workspace);
  const close = applyRule(
    ctx,
    "auto_close",
    settings.closeAfterDays,
    dryRun,
    limit,
    (days) => closeCandidates(ctx.db, workspace, days, current),
    (ref, days) => closeOne(ctx, ref, days),
  );
  const archive = applyRule(
    ctx,
    "auto_archive",
    settings.archiveAfterDays,
    dryRun,
    limit,
    (days) => archiveCandidates(ctx.db, workspace, days, current).filter((f) => !close.processed.includes(f.candidate.id)),
    (ref, days) => archiveOne(ctx, ref, days),
  );
  return { evaluatedAt, workspaceKey: workspace.key, dryRun, rules: [close, archive] };
}
