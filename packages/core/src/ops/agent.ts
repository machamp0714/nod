import { enterClarification } from "../clarification";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { addComment, recordEvent } from "../events";
import { OPEN_BLOCKER, READY_WHERE, findWritableIssueRow, formatIssueId, type IssueRow, issueRowById, type QuestionRow, toIssue, toQuestion } from "../issue-query";
import { setColumn } from "../mutate";
import { collapseIntoAgentNotification, lastNotificationId } from "../notify";
import type { Issue, Question } from "../types";
import { requireText } from "./issues";
import { resolveProject } from "./projects";

export interface WorkLocation {
  branch: string | null;
  worktree: string;
}

function recordLocation(ctx: OpCtx, row: IssueRow, location: WorkLocation | null | undefined): void {
  if (!location) return;
  setColumn(ctx, row, "branch", location.branch);
  setColumn(ctx, row, "worktree", location.worktree);
}

function beginWork(ctx: OpCtx, row: IssueRow, location: WorkLocation | null | undefined): void {
  setColumn(ctx, row, "assignee", ctx.actor);
  setColumn(ctx, row, "agent_state", "working");
  recordLocation(ctx, row, location);
}

// 指定した Issue への着手を妨げる未回答の確認依頼とブロッカーを調べる
function openQuestionsOf(issueId: string): string {
  return `FROM questions q WHERE q.issue_id = ${issueId} AND q.answer IS NULL`;
}

function openBlockersOf(issueId: string): string {
  return `FROM relations r JOIN issues b ON b.id = r.from_id JOIN workspaces bw ON bw.id = b.workspace_id
    WHERE r.to_id = ${issueId} AND r.type = 'blocks' AND ${OPEN_BLOCKER}`;
}

const NEXT_SQL = `SELECT i.id FROM issues i
WHERE i.workspace_id = ?
  AND ${READY_WHERE}
  AND (i.assignee IS NULL OR i.assignee = ?)
  AND (? IS NULL OR i.project_id = ?)
ORDER BY CASE i.priority WHEN 0 THEN 5 ELSE i.priority END, i.created_at, i.id`;

export function suggestIssue(
  ctx: OpCtx,
  opts: { workspaceId: number; projectRef?: string },
): Issue | null {
  const projectId = opts.projectRef ? resolveProject(ctx.db, opts.projectRef).id : null;
  const candidate = ctx.db.query(`${NEXT_SQL} LIMIT 1`).get(
    opts.workspaceId, now(), ctx.actor, projectId, projectId,
  ) as { id: number } | null;
  return candidate ? toIssue(issueRowById(ctx.db, candidate.id)) : null;
}

export function nextIssue(
  ctx: OpCtx,
  opts: { workspaceId: number; projectRef?: string; location?: WorkLocation | null },
): Issue | null {
  return tx(ctx.db, () => {
    const projectId = opts.projectRef ? resolveProject(ctx.db, opts.projectRef).id : null;
    const ts = now();
    const candidates = ctx.db.query(NEXT_SQL).all(opts.workspaceId, ts, ctx.actor, projectId, projectId) as { id: number }[];
    for (const c of candidates) {
      // ほかの接続が先に取っていたら更新件数が0になるので、次の候補に進む
      const claimed = ctx.db
        .query(
          "UPDATE issues SET status = 'in_progress', updated_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'todo'",
        )
        .run(ts, ts, c.id);
      if (claimed.changes === 0) continue;
      recordEvent(ctx.db, c.id, ctx.actor, "status_changed", { from: "todo", to: "in_progress" });
      const row = issueRowById(ctx.db, c.id);
      beginWork(ctx, row, opts.location);
      return toIssue(issueRowById(ctx.db, c.id));
    }
    return null;
  });
}

export function startIssue(ctx: OpCtx, ref: string, opts: { location?: WorkLocation | null } = {}): Issue {
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    if (row.status === "triage") {
      throw new NodError("NOT_ACCEPTED", `${ref} はまだ Triage にあります。受け入れられるまで着手できません`);
    }
    if (row.status === "needs_clarification") {
      throw new NodError(
        "NEEDS_CLARIFICATION",
        `${ref} には未回答の確認依頼（未決事項）が残っています。すべて回答されるまで着手できません`,
      );
    }
    if (row.status === "done" || row.status === "canceled") {
      throw new NodError("ISSUE_CLOSED", `${ref} はすでに ${row.status} です`);
    }
    if (row.assignee && row.assignee !== ctx.actor) {
      throw new NodError("ASSIGNED_TO_OTHER", `${ref} は ${row.assignee} が担当しています。別の Issue を取ってください`);
    }
    if (ctx.db.query(`SELECT 1 ${openQuestionsOf("?")}`).get(row.id)) {
      throw new NodError("AWAITING_ANSWER", `${ref} には未回答の確認依頼があります。回答を待ってください`);
    }
    const blockers = ctx.db
      .query(`SELECT bw.key AS key, b.number AS number ${openBlockersOf("?")} ORDER BY bw.key, b.number`)
      .all(row.id) as { key: string; number: number }[];
    if (blockers.length > 0) {
      const ids = blockers.map((b) => formatIssueId(b.key, b.number)).join(", ");
      throw new NodError("BLOCKED", `${ref} は ${ids} にブロックされています。先にそちらが終わるのを待ってください`);
    }
    setColumn(ctx, row, "status", "in_progress");
    beginWork(ctx, row, opts.location);
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

export interface AskResult {
  question: Question;
  created: boolean;
  issue: Issue;
}

export function askQuestion(ctx: OpCtx, ref: string, question: string): AskResult {
  requireText(question, "質問");
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    const issueId = toIssue(row).id;
    const existing = ctx.db
      .query("SELECT * FROM questions WHERE issue_id = ? AND answer IS NULL AND question = ?")
      .get(row.id, question) as QuestionRow | null;
    let asked: Question;
    if (existing) {
      asked = toQuestion(existing, issueId);
    } else {
      const { lastInsertRowid } = ctx.db
        .query("INSERT INTO questions (issue_id, question, asked_by, asked_at) VALUES (?, ?, ?, ?)")
        .run(row.id, question, ctx.actor, now());
      const id = Number(lastInsertRowid);
      recordEvent(ctx.db, row.id, ctx.actor, "question_asked", { question_id: id });
      asked = toQuestion(ctx.db.query("SELECT * FROM questions WHERE id = ?").get(id) as QuestionRow, issueId);
    }
    // 作業中なら LLM の作業を止め、着手前なら決めることが残っている Issue として扱う
    if (row.status === "in_progress") {
      if (isLlm(ctx)) setColumn(ctx, row, "agent_state", "awaiting_input", { reason: question });
    } else {
      enterClarification(ctx, row);
    }
    return { question: asked, created: !existing, issue: toIssue(issueRowById(ctx.db, row.id)) };
  });
}

export function failIssue(ctx: OpCtx, ref: string, reason: string): Issue {
  requireText(reason, "理由");
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    const since = lastNotificationId(ctx.db);
    addComment(ctx, row, `エラー: ${reason}`);
    setColumn(ctx, row, "agent_state", "error", { reason });
    collapseIntoAgentNotification(ctx.db, row.id, since);
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

export function completeIssue(ctx: OpCtx, ref: string, opts: { summary: string; prUrl?: string }): Issue {
  requireText(opts.summary, "報告（--summary）");
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    if (row.status !== "in_progress") {
      throw new NodError(
        "NOT_IN_PROGRESS",
        `${ref} は ${row.status} です。着手中（in_progress）の Issue だけをレビューに回せます`,
      );
    }
    const since = lastNotificationId(ctx.db);
    const report = addComment(ctx, row, opts.summary);
    if (opts.prUrl) setColumn(ctx, row, "pr_url", opts.prUrl);
    setColumn(ctx, row, "status", "in_review", { report_comment_id: report.id });
    setColumn(ctx, row, "agent_state", "done");
    collapseIntoAgentNotification(ctx.db, row.id, since);
    return toIssue(issueRowById(ctx.db, row.id));
  });
}
