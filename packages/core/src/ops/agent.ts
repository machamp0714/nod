import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { addComment, recordEvent } from "../events";
import { findIssueRow, type IssueRow, issueRowById, type QuestionRow, toIssue, toQuestion } from "../issue-query";
import { setColumn } from "../mutate";
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

const READY_SQL = `SELECT i.id FROM issues i
WHERE i.workspace_id = ?
  AND i.status = 'todo'
  AND (i.snoozed_until IS NULL OR i.snoozed_until <= ?)
  AND (i.assignee IS NULL OR i.assignee = ?)
  AND (? IS NULL OR i.project_id = ?)
  AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.issue_id = i.id AND q.answer IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM relations r JOIN issues b ON b.id = r.from_id
    WHERE r.to_id = i.id AND r.type = 'blocks' AND b.status NOT IN ('done', 'canceled')
  )
ORDER BY CASE i.priority WHEN 0 THEN 5 ELSE i.priority END, i.created_at, i.id`;

export function nextIssue(
  ctx: OpCtx,
  opts: { workspaceId: number; projectRef?: string; location?: WorkLocation | null },
): Issue | null {
  return tx(ctx.db, () => {
    const projectId = opts.projectRef ? resolveProject(ctx.db, opts.projectRef).id : null;
    const ts = now();
    const candidates = ctx.db.query(READY_SQL).all(opts.workspaceId, ts, ctx.actor, projectId, projectId) as { id: number }[];
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
    const row = findIssueRow(ctx.db, ref);
    if (row.status === "triage") {
      throw new NodError("NOT_ACCEPTED", `${ref} はまだ Triage にあります。受け入れられるまで着手できません`);
    }
    if (row.status === "done" || row.status === "canceled") {
      throw new NodError("ISSUE_CLOSED", `${ref} はすでに ${row.status} です`);
    }
    setColumn(ctx, row, "status", "in_progress");
    beginWork(ctx, row, opts.location);
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

export function askQuestion(ctx: OpCtx, ref: string, question: string): { question: Question; created: boolean } {
  requireText(question, "質問");
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    const issueId = toIssue(row).id;
    setColumn(ctx, row, "agent_state", "awaiting_input", { reason: question });
    const existing = ctx.db
      .query("SELECT * FROM questions WHERE issue_id = ? AND answer IS NULL AND question = ?")
      .get(row.id, question) as QuestionRow | null;
    if (existing) return { question: toQuestion(existing, issueId), created: false };
    const { lastInsertRowid } = ctx.db
      .query("INSERT INTO questions (issue_id, question, asked_by, asked_at) VALUES (?, ?, ?, ?)")
      .run(row.id, question, ctx.actor, now());
    const id = Number(lastInsertRowid);
    recordEvent(ctx.db, row.id, ctx.actor, "question_asked", { question_id: id });
    const inserted = ctx.db.query("SELECT * FROM questions WHERE id = ?").get(id) as QuestionRow;
    return { question: toQuestion(inserted, issueId), created: true };
  });
}

export function failIssue(ctx: OpCtx, ref: string, reason: string): Issue {
  requireText(reason, "理由");
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    addComment(ctx, row, `エラー: ${reason}`);
    setColumn(ctx, row, "agent_state", "error", { reason });
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

export function completeIssue(ctx: OpCtx, ref: string, opts: { summary: string; prUrl?: string }): Issue {
  requireText(opts.summary, "報告（--summary）");
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    if (row.status !== "in_progress") {
      throw new NodError(
        "NOT_IN_PROGRESS",
        `${ref} は ${row.status} です。着手中（in_progress）の Issue だけをレビューに回せます`,
      );
    }
    addComment(ctx, row, opts.summary);
    if (opts.prUrl) setColumn(ctx, row, "pr_url", opts.prUrl);
    setColumn(ctx, row, "status", "in_review");
    setColumn(ctx, row, "agent_state", "done");
    return toIssue(issueRowById(ctx.db, row.id));
  });
}
