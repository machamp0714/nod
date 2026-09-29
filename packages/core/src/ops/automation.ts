import type { Database } from "bun:sqlite";
import { latestActivity } from "../activity";
import { HUMAN_ACTOR, isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { findIssueRow, formatIssueId, OPEN_BLOCKER } from "../issue-query";
import { setColumn } from "../mutate";
import { recordedTimestamp } from "../recorded-time";
import type {
  AutomationCandidate,
  AutomationKind,
  AutomationRecurringResult,
  AutomationRuleResult,
  AutomationRun,
  AutomationSettings,
  AutomationTargets,
  Status,
  Workspace,
} from "../types";
import { applyAutoTransition, prReviewReason, prReviewTargets } from "./auto-transitions";
import { archiveIssue } from "./issues";
import { countEnabledRecurringIssues, runRecurringIssues } from "./recurring";
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
// 自動クローズでは、未完了の Issue をブロックしている Issue と、未完了のブロッカーを待つ Issue も除く。
// canceled にするとブロックが黙って解け、前提が終わっていない作業に LLM が着手してしまうため。
// 未完了は done・canceled 以外かつ未アーカイブ（ブロック元の数え方と同じ）
const NO_BLOCK_RELATION = `NOT EXISTS (SELECT 1 FROM relations r JOIN issues b ON b.id = r.to_id
    WHERE r.from_id = i.id AND r.type = 'blocks' AND ${OPEN_BLOCKER})
  AND NOT EXISTS (SELECT 1 FROM relations r JOIN issues b ON b.id = r.from_id
    WHERE r.to_id = i.id AND r.type = 'blocks' AND ${OPEN_BLOCKER})`;

interface SettingsRow {
  auto_close_days: number | null;
  auto_archive_days: number | null;
  pr_review_enabled: number;
  commit_review_enabled: number;
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
    .query(
      `SELECT auto_close_days, auto_archive_days, pr_review_enabled, commit_review_enabled, automation_updated_at, automation_updated_by
       FROM workspaces WHERE id = ?`,
    )
    .get(workspace.id) as SettingsRow;
  return {
    workspaceKey: workspace.key,
    closeAfterDays: row.auto_close_days,
    archiveAfterDays: row.auto_archive_days,
    prReview: row.pr_review_enabled === 1,
    commitReview: row.commit_review_enabled === 1,
    updatedAt: row.automation_updated_at,
    updatedBy: row.automation_updated_by,
  };
}

export function getAutomationSettings(db: Database, keyOrPath: string): AutomationSettings {
  return readSettings(db, requireWorkspace(db, keyOrPath));
}

// 渡した項目だけを変える。日数の null はそのルールを無効にする。prReview は PR 連動（#66）、commitReview はコミット連動（#68）の有効・無効
export function setAutomationSettings(
  ctx: OpCtx,
  keyOrPath: string,
  input: { closeAfterDays?: number | null; archiveAfterDays?: number | null; prReview?: boolean; commitReview?: boolean },
): AutomationSettings {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は自動化の設定を変えられません。変更は me に依頼してください");
  }
  validateDays(input.closeAfterDays, "自動クローズの日数");
  validateDays(input.archiveAfterDays, "自動アーカイブの日数");
  if (input.prReview !== undefined && typeof input.prReview !== "boolean") {
    throw new NodError("INVALID_ARGS", "PR 連動は true か false で指定してください");
  }
  if (input.commitReview !== undefined && typeof input.commitReview !== "boolean") {
    throw new NodError("INVALID_ARGS", "コミット連動は true か false で指定してください");
  }
  return tx(ctx.db, () => {
    const workspace = requireWorkspace(ctx.db, keyOrPath);
    const current = readSettings(ctx.db, workspace);
    ctx.db
      .query(
        `UPDATE workspaces SET auto_close_days = ?, auto_archive_days = ?, pr_review_enabled = ?, commit_review_enabled = ?,
          automation_updated_at = ?, automation_updated_by = ? WHERE id = ?`,
      )
      .run(
        input.closeAfterDays !== undefined ? input.closeAfterDays : current.closeAfterDays,
        input.archiveAfterDays !== undefined ? input.archiveAfterDays : current.archiveAfterDays,
        (input.prReview ?? current.prReview) ? 1 : 0,
        (input.commitReview ?? current.commitReview) ? 1 : 0,
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

function candidateOf(
  workspace: Workspace,
  row: Pick<CandidateRow, "number" | "title" | "status">,
  at: number,
  current: number,
): Found {
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

const CANDIDATE_SELECT = "SELECT i.id, i.number, i.title, i.status, i.created_at, i.updated_at, i.closed_at, i.snoozed_until FROM issues i";

// 最後の活動から days 日以上たった未完了の Issue。委任中（担当が me 以外）・スヌーズ中・ブロック関係のあるものは除く。
// issueId を渡すとその1件だけを確かめる（実行時の再確認）
function closeCandidates(db: Database, workspace: Workspace, days: number, current: number, issueId?: number): Found[] {
  const rows = db
    .query(`${CANDIDATE_SELECT}
      WHERE i.workspace_id = ? AND i.archived_at IS NULL ${issueId === undefined ? "" : "AND i.id = ?"}
        AND i.status IN (${CLOSE_STATUSES.map(() => "?").join(", ")})
        AND (i.assignee IS NULL OR i.assignee = ?)
        AND ${NO_OPEN_CHILD}
        AND ${NO_BLOCK_RELATION}`)
    .all(workspace.id, ...(issueId === undefined ? [] : [issueId]), ...CLOSE_STATUSES, HUMAN_ACTOR) as CandidateRow[];
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
function archiveCandidates(db: Database, workspace: Workspace, days: number, current: number, issueId?: number): Found[] {
  const rows = db
    .query(`${CANDIDATE_SELECT}
      WHERE i.workspace_id = ? AND i.archived_at IS NULL ${issueId === undefined ? "" : "AND i.id = ?"}
        AND i.status IN ('done', 'canceled') AND ${NO_OPEN_CHILD}`)
    .all(workspace.id, ...(issueId === undefined ? [] : [issueId])) as CandidateRow[];
  const found: Found[] = [];
  for (const row of rows) {
    const closedAt = recordedTimestamp(row.closed_at);
    if (closedAt === null || current - closedAt < days * DAY_MS) continue;
    found.push(candidateOf(workspace, row, closedAt, current));
  }
  return sorted(found);
}

type Finder = (days: number, issueId?: number) => Found[];

// PR 連動（#66）。保存済みの PR 状態（Issue の現在の PR URL のもの）で評価し、gh は呼ばない
function prReviewCandidates(db: Database, workspace: Workspace, current: number, issueId?: number): Found[] {
  return prReviewTargets(db, workspace.id, issueId).flatMap((t) => {
    const at = recordedTimestamp(t.fetched_at);
    if (at === null) return [];
    const found = candidateOf(workspace, t, at, current);
    found.candidate.prUrl = t.pr_url;
    found.candidate.prState = t.state;
    return [found];
  });
}

function prReviewOne(ctx: OpCtx, find: Finder, ref: string): boolean {
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    const found = find(0, row.id)[0];
    if (!found?.candidate.prUrl || !found.candidate.prState) return false;
    applyAutoTransition(ctx, row, {
      source: "pr",
      sourceKey: found.candidate.prUrl,
      reason: prReviewReason(found.candidate.prState),
      automation: "pr_review",
      mergeCandidate: found.candidate.prState === "MERGED",
    });
    return true;
  });
}

// 自動クローズ1件。候補を探してから処理するまでにほかの操作で変わりうるので、書き込む transaction の中で
// 同じ条件（状態・担当・子・ブロック関係・スヌーズ・経過日数）を確かめ直し、外れていれば何もしない（スキップ）
function closeOne(ctx: OpCtx, find: Finder, ref: string, days: number): boolean {
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    if (find(days, row.id).length === 0) return false;
    const reason = closeReasonOf(days);
    setColumn(ctx, row, "close_reason", reason);
    setColumn(ctx, row, "status", "canceled", { reason, automation: "auto_close" });
    setColumn(ctx, row, "agent_state", null);
    return true;
  });
}

function archiveOne(ctx: OpCtx, find: Finder, ref: string, days: number): boolean {
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    if (find(days, row.id).length === 0) return false;
    return archiveIssue(ctx, ref, { reason: archiveReasonOf(days), automation: "auto_archive" }).archivedAt !== null;
  });
}

function applyRule(
  ctx: OpCtx,
  kind: AutomationKind,
  days: number | null,
  enabled: boolean,
  dryRun: boolean,
  limit: number,
  targets: string[] | undefined,
  find: Finder,
  act: (find: Finder, ref: string, days: number) => boolean,
): AutomationRuleResult {
  const result: AutomationRuleResult = {
    kind,
    days,
    enabled,
    total: 0,
    candidates: [],
    processed: [],
    skipped: [],
    failed: [],
    remaining: 0,
  };
  if (!enabled) {
    result.skipped = targets ? [...targets] : [];
    return result;
  }
  const found = find(days ?? 0);
  result.total = found.length;
  // targets（確認時点の一覧）があれば、そのうちいまも条件に合うものだけを扱い、外れたものはスキップにする
  const listed = targets ? found.filter((f) => targets.includes(f.candidate.id)) : found.slice(0, limit);
  result.candidates = listed.map((f) => f.candidate);
  result.remaining = found.length - result.candidates.length;
  if (targets) {
    const current = new Set(result.candidates.map((c) => c.id));
    result.skipped = targets.filter((id) => !current.has(id));
  }
  if (dryRun) return result;
  // 1件ごとに確定し、途中で失敗しても残りを続ける
  for (const candidate of result.candidates) {
    try {
      if (act(find, candidate.id, days ?? 0)) result.processed.push(candidate.id);
      else result.skipped.push(candidate.id);
    } catch (e) {
      result.failed.push({ id: candidate.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

function validateTargets(targets: AutomationTargets | undefined): void {
  if (targets === undefined) return;
  const recurring: unknown = targets.recurring;
  if (
    recurring !== undefined &&
    (!Array.isArray(recurring) || recurring.length > AUTOMATION_LIMIT_MAX || !recurring.every((id) => Number.isSafeInteger(id) && id > 0))
  ) {
    throw new NodError("INVALID_ARGS", `targets.recurring は ${AUTOMATION_LIMIT_MAX} 件以下の定期Issueの id（正の整数）の配列で指定してください`);
  }
  for (const kind of ["auto_close", "auto_archive", "pr_review"] as const) {
    const list: unknown = targets[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > AUTOMATION_LIMIT_MAX || !list.every((id) => typeof id === "string")) {
      throw new NodError("INVALID_ARGS", `targets.${kind} は ${AUTOMATION_LIMIT_MAX} 件以下の Issue ID の配列で指定してください`);
    }
  }
}

// 定期Issue（#32）の起票。targets を渡したら、その一覧（recurring）の定期Issueだけを起票し、起票しなかったものを notRun で返す
function applyRecurring(
  ctx: OpCtx,
  workspace: Workspace,
  dryRun: boolean,
  current: number,
  targets: number[] | undefined,
): AutomationRecurringResult {
  const enabled = countEnabledRecurringIssues(ctx.db, workspace.id);
  if (targets !== undefined && targets.length === 0) return { enabled, items: [], notRun: [], failed: [] };
  const run = runRecurringIssues(ctx, workspace.key, { dryRun, now: new Date(current), only: targets });
  const handled = new Set([...run.items, ...run.failed].map((i) => i.recurringId));
  return { enabled, items: run.items, notRun: (targets ?? []).filter((id) => !handled.has(id)), failed: run.failed };
}

// 有効なルールを1回だけ評価・実行する。定期Issueの起票（#32）を最初に行い、その回で起票した Issue はほかのルールの対象にしない。
// 次に PR 連動を行い（PR がレビュー待ちの Issue を自動クローズしない）、
// 次に自動クローズを行い、その回で閉じた Issue はアーカイブしない。結果の rules は auto_close・auto_archive・pr_review の順。
// targets を渡すと、各ルールはその Issue（確認時点の一覧）だけを扱い、limit は使わない。targets に一覧のないルールは何もしない
export function runAutomation(
  ctx: OpCtx,
  keyOrPath: string,
  opts: { dryRun?: boolean; limit?: number; evaluatedAt?: string; targets?: AutomationTargets } = {},
): AutomationRun {
  const dryRun = opts.dryRun ?? false;
  if (!dryRun && isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は自動化を実行できません（--dry-run での確認はできます）。実行は me に依頼してください");
  }
  const limit = opts.limit ?? AUTOMATION_LIMIT_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > AUTOMATION_LIMIT_MAX) {
    throw new NodError("INVALID_ARGS", `--limit は 1〜${AUTOMATION_LIMIT_MAX} の整数で指定してください`);
  }
  validateTargets(opts.targets);
  const evaluatedAt = opts.evaluatedAt ?? now();
  const current = recordedTimestamp(evaluatedAt);
  if (current === null) throw new NodError("INVALID_ARGS", "自動化の基準日時が正しくありません");
  const workspace = requireWorkspace(ctx.db, keyOrPath);
  const settings = readSettings(ctx.db, workspace);
  // targets を渡したのに recurring の一覧がなければ、確認していない起票はしない
  const recurring = applyRecurring(ctx, workspace, dryRun, current, opts.targets ? (opts.targets.recurring ?? []) : undefined);
  const created = new Set(recurring.items.flatMap((i) => (i.issueId === null ? [] : [i.issueId])));
  const notCreated = (found: Found[]) => found.filter((f) => !created.has(f.candidate.id));
  // targets を渡したのに pr_review の一覧がなければ、確認していない PR 連動は実行しない
  const prReview = applyRule(
    ctx,
    "pr_review",
    null,
    settings.prReview,
    dryRun,
    limit,
    opts.targets ? (opts.targets.pr_review ?? []) : undefined,
    (_days, issueId) => notCreated(prReviewCandidates(ctx.db, workspace, current, issueId)),
    (find, ref) => prReviewOne(ctx, find, ref),
  );
  const close = applyRule(
    ctx,
    "auto_close",
    settings.closeAfterDays,
    settings.closeAfterDays !== null,
    dryRun,
    limit,
    opts.targets?.auto_close,
    (days, issueId) => notCreated(closeCandidates(ctx.db, workspace, days, current, issueId)),
    (find, ref, days) => closeOne(ctx, find, ref, days),
  );
  const archive = applyRule(
    ctx,
    "auto_archive",
    settings.archiveAfterDays,
    settings.archiveAfterDays !== null,
    dryRun,
    limit,
    opts.targets?.auto_archive,
    (days, issueId) =>
      notCreated(archiveCandidates(ctx.db, workspace, days, current, issueId)).filter((f) => !close.processed.includes(f.candidate.id)),
    (find, ref, days) => archiveOne(ctx, find, ref, days),
  );
  return { evaluatedAt, workspaceKey: workspace.key, dryRun, rules: [close, archive, prReview], recurring };
}
