import type { Database } from "bun:sqlite";
import { enterClarification, leaveClarification, openQuestionCount } from "../clarification";
import { HUMAN_ACTOR, isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { addComment, recordEvent } from "../events";
import {
  findIssueRow,
  formatIssueId,
  type IssueRow,
  issueRowById,
  type QuestionRow,
  selectIssues,
  toIssue,
  toQuestion,
} from "../issue-query";
import { setColumn } from "../mutate";
import type { Inbox, InboxQuestion, Issue, Question, Status } from "../types";
import { addRelation, requireText } from "./issues";

export function getInbox(db: Database): Inbox {
  const rows = db
    .query(
      `SELECT q.*, i.title AS issue_title, i.number AS issue_number, i.branch AS branch, i.worktree AS worktree, w.key AS ws_key
       FROM questions q JOIN issues i ON i.id = q.issue_id JOIN workspaces w ON w.id = i.workspace_id
       WHERE q.answer IS NULL AND q.asked_by <> ? AND i.status NOT IN ('done', 'canceled') ORDER BY q.asked_at, q.id`,
    )
    .all(HUMAN_ACTOR) as (QuestionRow & {
    issue_title: string;
    issue_number: number;
    branch: string | null;
    worktree: string | null;
    ws_key: string;
  })[];
  const questions: InboxQuestion[] = rows.map((r) => ({
    ...toQuestion(r, formatIssueId(r.ws_key, r.issue_number)),
    issueTitle: r.issue_title,
    workspace: r.ws_key,
    branch: r.branch,
    worktree: r.worktree,
  }));
  const reviews = selectIssues(db, "WHERE i.status = 'in_review' ORDER BY i.updated_at, i.id", []);
  return { questions, reviews };
}

// web の Triage。Snooze の期限が来ていないものは除く
export function listTriage(db: Database): Issue[] {
  return selectIssues(
    db,
    "WHERE i.status = 'triage' AND (i.snoozed_until IS NULL OR i.snoozed_until <= ?) ORDER BY i.created_at, i.id",
    [now()],
  );
}

function openLlmQuestions(ctx: OpCtx, row: IssueRow, ref: string): QuestionRow[] {
  const open = ctx.db
    .query("SELECT * FROM questions WHERE issue_id = ? AND answer IS NULL AND asked_by <> ? ORDER BY id")
    .all(row.id, HUMAN_ACTOR) as QuestionRow[];
  if (open.length > 0) return open;
  const mine = openQuestionCount(ctx.db, row.id);
  throw new NodError(
    "NO_OPEN_QUESTION",
    mine > 0
      ? `${ref} に LLM からの未回答の確認依頼はありません。未決事項（${mine} 件）には --question <質問の id> で1つずつ回答してください`
      : `${ref} に未回答の確認依頼はありません`,
  );
}

function pickQuestion(ctx: OpCtx, row: IssueRow, ref: string, questionId: number): QuestionRow {
  const q = ctx.db.query("SELECT * FROM questions WHERE id = ? AND issue_id = ?").get(questionId, row.id) as QuestionRow | null;
  if (!q) throw new NodError("NOT_FOUND", `${ref} に質問 ${questionId} はありません`);
  if (q.answer !== null) throw new NodError("NO_OPEN_QUESTION", `質問 ${questionId} はすでに回答済みです`);
  return q;
}

// 既定では LLM からの未回答の質問にまとめて答え、questionId があればその質問だけに答える
export function answerQuestion(
  ctx: OpCtx,
  ref: string,
  answer: string,
  opts: { questionId?: number } = {},
): { issue: Issue; answered: Question[] } {
  requireText(answer, "回答");
  if (opts.questionId !== undefined && (!Number.isSafeInteger(opts.questionId) || opts.questionId <= 0)) {
    throw new NodError("INVALID_ARGS", "質問の id は安全な範囲の正の整数で指定してください（例: 3）");
  }
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    const issueId = toIssue(row).id;
    const targets =
      opts.questionId === undefined ? openLlmQuestions(ctx, row, ref) : [pickQuestion(ctx, row, ref, opts.questionId)];
    const ts = now();
    const update = ctx.db.query("UPDATE questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?");
    for (const q of targets) {
      update.run(answer, ctx.actor, ts, q.id);
      recordEvent(ctx.db, row.id, ctx.actor, "question_answered", { question_id: q.id });
    }
    // LLM の質問がすべて回答されたら、止めていた作業を再開できる状態に戻す
    if (row.agent_state === "awaiting_input" && openQuestionCount(ctx.db, row.id, { llmOnly: true }) === 0) {
      setColumn(ctx, row, "agent_state", "working");
    }
    leaveClarification(ctx, row);
    const answered = targets.map((q) => toQuestion({ ...q, answer, answered_by: ctx.actor, answered_at: ts }, issueId));
    return { issue: toIssue(issueRowById(ctx.db, row.id)), answered };
  });
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

// 年月日が実在するか（2026-02-30 などを拒む）
function isRealDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function parseDateTime(value: string): string {
  const invalid = () =>
    new NodError("INVALID_ARGS", `${value} は日時として解釈できません（例: 2026-10-01、2026-10-01T09:00:00+09:00）`);
  const d = DATE_RE.exec(value);
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    if (!isRealDate(y, m, day)) throw invalid();
    return new Date(y, m - 1, day).toISOString();
  }
  const dt = DATETIME_RE.exec(value);
  if (!dt || !isRealDate(Number(dt[1]), Number(dt[2]), Number(dt[3]))) throw invalid();
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw invalid();
  return new Date(t).toISOString();
}

function requireStatus(row: IssueRow, ref: string, status: Status, code: string): void {
  if (row.status !== status) throw new NodError(code, `${ref} は ${row.status} です（${status} の Issue だけを扱えます）`);
}

export function acceptTriage(ctx: OpCtx, ref: string): Issue {
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    requireStatus(row, ref, "triage", "NOT_IN_TRIAGE");
    setColumn(ctx, row, "status", "todo");
    setColumn(ctx, row, "snoozed_until", null);
    recordEvent(ctx.db, row.id, ctx.actor, "triage_accepted", {});
    enterClarification(ctx, row);
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

export function declineTriage(ctx: OpCtx, ref: string, reason?: string): Issue {
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    requireStatus(row, ref, "triage", "NOT_IN_TRIAGE");
    setColumn(ctx, row, "close_reason", reason ?? null);
    setColumn(ctx, row, "status", "canceled");
    recordEvent(ctx.db, row.id, ctx.actor, "triage_declined", reason ? { reason } : {});
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

export function duplicateTriage(ctx: OpCtx, ref: string, originalRef: string): Issue {
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    requireStatus(row, ref, "triage", "NOT_IN_TRIAGE");
    const original = findIssueRow(ctx.db, originalRef);
    const reason = `${formatIssueId(original.ws_key, original.number)} の重複`;
    addRelation(ctx, row, original, "duplicate");
    setColumn(ctx, row, "close_reason", reason);
    setColumn(ctx, row, "status", "canceled");
    recordEvent(ctx.db, row.id, ctx.actor, "triage_declined", { reason });
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

export function snoozeTriage(ctx: OpCtx, ref: string, until: string): Issue {
  const iso = parseDateTime(until);
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    requireStatus(row, ref, "triage", "NOT_IN_TRIAGE");
    setColumn(ctx, row, "snoozed_until", iso);
    recordEvent(ctx.db, row.id, ctx.actor, "snoozed", { until: iso });
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

export function approveReview(ctx: OpCtx, ref: string): Issue {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM はレビューを承認できません。承認は me が行います");
  }
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    requireStatus(row, ref, "in_review", "NOT_IN_REVIEW");
    setColumn(ctx, row, "status", "done");
    recordEvent(ctx.db, row.id, ctx.actor, "review_approved", {});
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

export function rejectReview(ctx: OpCtx, ref: string, reason: string): Issue {
  requireText(reason, "差し戻しの理由");
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    requireStatus(row, ref, "in_review", "NOT_IN_REVIEW");
    addComment(ctx, row, reason);
    setColumn(ctx, row, "status", "in_progress");
    setColumn(ctx, row, "agent_state", null);
    recordEvent(ctx.db, row.id, ctx.actor, "review_rejected", { reason });
    return toIssue(issueRowById(ctx.db, row.id));
  });
}
