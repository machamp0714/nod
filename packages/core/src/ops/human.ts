import type { Database } from "bun:sqlite";
import { enterClarification, leaveClarification, openQuestionCount } from "../clarification";
import { HUMAN_ACTOR, isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { addComment, recordEvent } from "../events";
import {
  findIssueRow,
  findWritableIssueRow,
  formatIssueId,
  type IssueRow,
  issueRowById,
  type QuestionRow,
  selectIssues,
  toIssue,
  toQuestion,
} from "../issue-query";
import { setColumn } from "../mutate";
import { collapseNotifications, lastNotificationId, readAgentNotifications } from "../notify";
import { readReviewSummaries } from "../review-summary";
import type { AcceptTriageInput, AgentInstruction, Inbox, InboxQuestion, Issue, Question, Status } from "../types";
import { addInstruction } from "./instructions";
import { addRelation, requireText, updateIssue } from "./issues";

export function getInbox(db: Database, opts: { includeAnswered?: boolean } = {}): Inbox {
  const rows = db
    .query(
      `SELECT q.*, i.title AS issue_title, i.number AS issue_number, i.branch AS branch, i.worktree AS worktree, w.key AS ws_key
       FROM questions q JOIN issues i ON i.id = q.issue_id JOIN workspaces w ON w.id = i.workspace_id
       WHERE q.asked_by <> ? AND i.archived_at IS NULL ${opts.includeAnswered ? "" : "AND q.answer IS NULL AND i.status NOT IN ('done', 'canceled')"} ORDER BY q.asked_at, q.id`,
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
  const reviews = selectIssues(db, "WHERE i.status = 'in_review' AND i.archived_at IS NULL ORDER BY i.updated_at, i.id", []);
  const summaries = readReviewSummaries(db, reviews.map(i => i.id));
  return { questions, reviews: reviews.map(i => ({ ...i, ...summaries.get(i.id)! })) };
}

// web の Triage。Snooze の期限が来ていないものは除く
export function listTriage(db: Database): Issue[] {
  return selectIssues(
    db,
    "WHERE i.status = 'triage' AND i.archived_at IS NULL AND (i.snoozed_until IS NULL OR i.snoozed_until <= ?) ORDER BY i.created_at, i.id",
    [now()],
  );
}

function openLlmQuestions(ctx: OpCtx, row: IssueRow, ref: string): QuestionRow[] {
  const open = ctx.db
    .query("SELECT * FROM questions WHERE issue_id = ? AND answer IS NULL AND asked_by <> ? ORDER BY id")
    .all(row.id, HUMAN_ACTOR) as QuestionRow[];
  if (open.length > 0) return open;
  const mine = openQuestionCount(ctx.db, row.id);
  // me の未決事項は LLM には回答できないため、LLM を --question へ誘導しない
  const rest = isLlm(ctx)
    ? `未決事項（${mine} 件）は me が決めます`
    : `未決事項（${mine} 件）には --question <質問の id> で1つずつ回答してください`;
  throw new NodError(
    "NO_OPEN_QUESTION",
    mine > 0 ? `${ref} に LLM からの未回答の確認依頼はありません。${rest}` : `${ref} に未回答の確認依頼はありません`,
  );
}

function pickQuestion(ctx: OpCtx, row: IssueRow, ref: string, questionId: number): QuestionRow {
  const q = ctx.db.query("SELECT * FROM questions WHERE id = ? AND issue_id = ?").get(questionId, row.id) as QuestionRow | null;
  if (!q) throw new NodError("NOT_FOUND", `${ref} に質問 ${questionId} はありません`);
  // 人が付けた未決事項を決めるのは人だけ。判定は回答者だけでなく、質問に記録された書き手（asked_by）で行う（#172）
  if (isLlm(ctx) && q.asked_by === HUMAN_ACTOR) {
    throw new NodError(
      "FORBIDDEN_FOR_LLM",
      `LLM は me が付けた未決事項（質問 ${questionId}）に回答できません。回答は me に依頼してください`,
    );
  }
  if (q.answer !== null) throw new NodError("NO_OPEN_QUESTION", `質問 ${questionId} はすでに回答済みです`);
  return q;
}

// 既定では LLM からの未回答の質問にまとめて答え、questionId があればその質問だけに答える。
// me が付けた質問に LLM は回答できない（まとめての回答は元から me の質問を対象にしない）
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
    const row = findWritableIssueRow(ctx.db, ref);
    const issueId = toIssue(row).id;
    const targets =
      opts.questionId === undefined ? openLlmQuestions(ctx, row, ref) : [pickQuestion(ctx, row, ref, opts.questionId)];
    const ts = now();
    const update = ctx.db.query("UPDATE questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?");
    for (const q of targets) {
      update.run(answer, ctx.actor, ts, q.id);
      recordEvent(ctx.db, row.id, ctx.actor, "question_answered", { question_id: q.id });
    }
    // LLM の質問がすべて回答されたら、止めていた作業を再開できる状態に戻す。
    // その LLM の通知は入力待ちが解けたときだけ対応済みとして既読にする（me 自身の質問への回答や、未回答が残る回答では既読にしない）
    if (row.status === "in_progress" && row.agent_state === "awaiting_input" && openQuestionCount(ctx.db, row.id, { askedBy: "llm" }) === 0) {
      setColumn(ctx, row, "agent_state", "working", { trigger: "answer" });
      if (!isLlm(ctx)) readAgentNotifications(ctx.db, row.id, ctx.actor);
    }
    leaveClarification(ctx, row);
    const answered = targets.map((q) => toQuestion({ ...q, answer, answered_by: ctx.actor, answered_at: ts }, issueId));
    return { issue: toIssue(issueRowById(ctx.db, row.id)), answered };
  });
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// 日付と時刻の区切りは T か空白1つ（CLI が表示する YYYY-MM-DD HH:mm をそのまま貼れるようにする）
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

// 年月日が実在するか（2026-02-30 などを拒む）
function isRealDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function parseDateTime(value: string): string {
  const invalid = () =>
    new NodError("INVALID_ARGS", `${value} は日時として解釈できません（例: 2026-10-01、2026-10-01 09:00、2026-10-01T09:00:00+09:00）`);
  const d = DATE_RE.exec(value);
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    if (!isRealDate(y, m, day)) throw invalid();
    return new Date(y, m - 1, day).toISOString();
  }
  const dt = DATETIME_RE.exec(value);
  if (!dt || !isRealDate(Number(dt[1]), Number(dt[2]), Number(dt[3]))) throw invalid();
  // 空白区切りの解釈は処理系に依存するため T にそろえる。オフセットの無い入力はローカル時刻になる
  const t = Date.parse(value.replace(" ", "T"));
  if (Number.isNaN(t)) throw invalid();
  return new Date(t).toISOString();
}

function requireStatus(row: IssueRow, ref: string, status: Status, code: string): void {
  if (row.status !== status) throw new NodError(code, `${ref} は ${row.status} です（${status} の Issue だけを扱えます）`);
}

function requireHumanTriage(ctx: OpCtx): void {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は Triage の受け入れ・却下・重複の判断をできません。判断は me に依頼してください");
  }
}

export function acceptTriage(ctx: OpCtx, ref: string, input: AcceptTriageInput = {}): Issue {
  requireHumanTriage(ctx);
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    requireStatus(row, ref, "triage", "NOT_IN_TRIAGE");
    // 担当は null で未割当、文字列なら前後の空白を除いて空でないこと
    const assignee = typeof input.assignee === "string" ? requireText(input.assignee, "担当").trim() : input.assignee;
    const since = lastNotificationId(ctx.db);
    updateIssue(ctx, ref, {
      projectRef: input.projectRef, priority: input.priority, addLabels: input.addLabels, removeLabels: input.removeLabels, assignee,
    });
    Object.assign(row, issueRowById(ctx.db, row.id));
    setColumn(ctx, row, "status", "todo");
    setColumn(ctx, row, "snoozed_until", null);
    recordEvent(ctx.db, row.id, ctx.actor, "triage_accepted", {});
    collapseNotifications(ctx.db, row.id, since, "triage_accepted");
    enterClarification(ctx, row);
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

export function declineTriage(ctx: OpCtx, ref: string, reason?: string): Issue {
  requireHumanTriage(ctx);
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    requireStatus(row, ref, "triage", "NOT_IN_TRIAGE");
    const since = lastNotificationId(ctx.db);
    setColumn(ctx, row, "close_reason", reason ?? null);
    setColumn(ctx, row, "status", "canceled");
    recordEvent(ctx.db, row.id, ctx.actor, "triage_declined", reason ? { reason } : {});
    collapseNotifications(ctx.db, row.id, since, "triage_declined");
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

export function duplicateTriage(ctx: OpCtx, ref: string, originalRef: string): Issue {
  requireHumanTriage(ctx);
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    requireStatus(row, ref, "triage", "NOT_IN_TRIAGE");
    const original = findWritableIssueRow(ctx.db, originalRef);
    const since = lastNotificationId(ctx.db);
    const reason = `${formatIssueId(original.ws_key, original.number)} の重複`;
    addRelation(ctx, row, original, "duplicate");
    setColumn(ctx, row, "close_reason", reason);
    setColumn(ctx, row, "status", "canceled");
    recordEvent(ctx.db, row.id, ctx.actor, "triage_declined", { reason });
    collapseNotifications(ctx.db, row.id, since, "triage_declined");
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

export function snoozeTriage(ctx: OpCtx, ref: string, until: string): Issue {
  const iso = parseDateTime(until);
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
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
    const row = findWritableIssueRow(ctx.db, ref);
    requireStatus(row, ref, "in_review", "NOT_IN_REVIEW");
    const since = lastNotificationId(ctx.db);
    setColumn(ctx, row, "status", "done");
    recordEvent(ctx.db, row.id, ctx.actor, "review_approved", {});
    collapseNotifications(ctx.db, row.id, since, "review_approved");
    readAgentNotifications(ctx.db, row.id, ctx.actor);
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

// 差し戻しで LLM に頼む対応（#58）。指摘対応か、ベースブランチへの rebase か
export type ReviewDelegation = "review_fix" | "rebase";

// 差し戻しの対応依頼の本文。理由と手順を決まった形で書き、LLM が nod issue start / show で読む
export function delegationInstruction(issueId: string, delegate: ReviewDelegation, reason: string): string {
  const steps =
    delegate === "review_fix"
      ? ["理由に書かれた指摘に対応する", `テストを実行し、nod issue done ${issueId} --summary "<対応の要約>" で再提出する`]
      : ["ベースブランチの最新に rebase し、競合を解消する", `テストを再実行して push し、nod issue done ${issueId} --summary "<対応の要約>" で再提出する`];
  return [
    `差し戻しの対応依頼（${delegate === "review_fix" ? "指摘対応" : "rebase"}）`,
    `理由: ${reason.trim()}`,
    "手順:",
    `1. nod issue start ${issueId} で再開する`,
    ...steps.map((step, i) => `${i + 2}. ${step}`),
  ].join("\n");
}

// delegate を渡すと、理由を構造化した対応依頼（追加指示）として記録する（人だけ）。送信は #51 と同じく確認画面から人が行う
export function rejectReview(
  ctx: OpCtx,
  ref: string,
  reason: string,
  opts: { delegate?: ReviewDelegation } = {},
): Issue & { instruction?: AgentInstruction } {
  requireText(reason, "差し戻しの理由");
  if (opts.delegate !== undefined && opts.delegate !== "review_fix" && opts.delegate !== "rebase") {
    throw new NodError("INVALID_ARGS", "対応依頼は review_fix（指摘対応）か rebase で指定してください");
  }
  if (opts.delegate && isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は差し戻しの対応依頼を記録できません。対応依頼は me が行います");
  }
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    requireStatus(row, ref, "in_review", "NOT_IN_REVIEW");
    const since = lastNotificationId(ctx.db);
    // 対応依頼は理由を含むので、理由だけのコメントは別に残さない
    const instruction = opts.delegate
      ? addInstruction(ctx, row, delegationInstruction(formatIssueId(row.ws_key, row.number), opts.delegate, reason), opts.delegate)
      : undefined;
    if (!instruction) addComment(ctx, row, reason);
    setColumn(ctx, row, "status", "in_progress");
    setColumn(ctx, row, "agent_state", null);
    recordEvent(ctx.db, row.id, ctx.actor, "review_rejected", opts.delegate ? { reason, delegate: opts.delegate } : { reason });
    collapseNotifications(ctx.db, row.id, since, "review_rejected");
    if (!isLlm(ctx)) readAgentNotifications(ctx.db, row.id, ctx.actor);
    const issue = toIssue(issueRowById(ctx.db, row.id));
    return instruction ? { ...issue, instruction } : issue;
  });
}
