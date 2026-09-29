import type { Database } from "bun:sqlite";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { clearUnreadTriageProposal, notifyTriageProposal } from "../notify";
import { findIssueRow, findWritableIssueRow, formatIssueId, type IssueRow } from "../issue-query";
import { TRIAGE_DECISIONS, type TriageProposal, type TriageProposalInput } from "../types";
import { requireText, validatePriority } from "./issues";
import { resolveProject } from "./projects";
import { normalizeLabelName } from "./workspace-labels";

// LLM の Triage 提案（#62）。提案は triage_proposals だけに書き、Issue・ラベル・関係・event は変えない。
// LLM の提案と取り下げは me 宛ての提案通知（#125）だけを作る・消す
// 受け入れ・却下・重複の確定は人だけが accept / decline / duplicate で行う（FORBIDDEN_FOR_LLM は human.ts のまま）
export const PROPOSAL_REASON_MAX_LENGTH = 2000;
export const PROPOSAL_ASSIGNEE_MAX_LENGTH = 100;

interface ProposalRow {
  issue_id: number;
  actor: string;
  decision: TriageProposal["decision"];
  labels: string;
  assignee: string | null;
  priority: number | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
  issue_key: string;
  issue_number: number;
  dup_key: string | null;
  dup_number: number | null;
  project_id: number | null;
  project_name: string | null;
}

const SELECT = `SELECT p.*, w.key AS issue_key, i.number AS issue_number, dw.key AS dup_key, d.number AS dup_number, pr.name AS project_name
  FROM triage_proposals p
  JOIN issues i ON i.id = p.issue_id JOIN workspaces w ON w.id = i.workspace_id
  LEFT JOIN issues d ON d.id = p.duplicate_of_id LEFT JOIN workspaces dw ON dw.id = d.workspace_id
  LEFT JOIN projects pr ON pr.id = p.project_id`;

function toProposal(r: ProposalRow): TriageProposal {
  return {
    issueId: formatIssueId(r.issue_key, r.issue_number),
    actor: r.actor,
    decision: r.decision,
    duplicateOf: r.dup_key && r.dup_number !== null ? formatIssueId(r.dup_key, r.dup_number) : null,
    labels: JSON.parse(r.labels) as string[],
    assignee: r.assignee,
    priority: r.priority,
    project: r.project_id !== null && r.project_name !== null ? { id: r.project_id, name: r.project_name } : null,
    reason: r.reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function normalizeLabels(labels: string[]): string[] {
  const out: string[] = [];
  for (const raw of labels) {
    const label = normalizeLabelName(requireText(raw, "ラベル"));
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

function validateInput(input: TriageProposalInput): void {
  if (!(TRIAGE_DECISIONS as readonly string[]).includes(input.decision)) {
    throw new NodError("INVALID_ARGS", "提案は accept・decline・duplicate のいずれかで指定してください");
  }
  if ((input.decision === "duplicate") !== (input.duplicateOf !== undefined)) {
    throw new NodError("INVALID_ARGS", "重複の提案には元の Issue の ID が必要で、それ以外の提案には指定できません");
  }
  const acceptOnly = [input.labels, input.assignee, input.priority, input.projectRef].some((v) => v !== undefined);
  if (input.decision !== "accept" && acceptOnly) {
    throw new NodError("INVALID_ARGS", "ラベル・担当・優先度・Project は受け入れの提案にだけ指定できます");
  }
  if (input.priority !== undefined) validatePriority(input.priority);
  if (input.reason !== undefined && input.reason.length > PROPOSAL_REASON_MAX_LENGTH) {
    throw new NodError("INVALID_ARGS", `理由は ${PROPOSAL_REASON_MAX_LENGTH} 文字までです`);
  }
}

function requireTriage(row: IssueRow, ref: string): void {
  if (row.status !== "triage") {
    throw new NodError("NOT_IN_TRIAGE", `${ref} は ${row.status} です（triage の Issue にだけ提案できます）`);
  }
}

// 書き手ごとに1件。同じ書き手の再提案は内容をすべて置き換え、created_at だけ残す
export function proposeTriage(ctx: OpCtx, ref: string, input: TriageProposalInput): TriageProposal {
  validateInput(input);
  const labels = normalizeLabels(input.labels ?? []);
  const assignee = input.assignee === undefined ? null : requireText(input.assignee, "担当").trim();
  if (assignee !== null && assignee.length > PROPOSAL_ASSIGNEE_MAX_LENGTH) {
    throw new NodError("INVALID_ARGS", `担当は ${PROPOSAL_ASSIGNEE_MAX_LENGTH} 文字までです`);
  }
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    requireTriage(row, ref);
    let duplicateOfId: number | null = null;
    if (input.duplicateOf !== undefined) {
      const original = findWritableIssueRow(ctx.db, input.duplicateOf);
      if (original.id === row.id) throw new NodError("INVALID_ARGS", "Issue 自身の重複にはできません");
      duplicateOfId = original.id;
    }
    const project = input.projectRef !== undefined ? resolveProject(ctx.db, input.projectRef) : null;
    const ts = now();
    ctx.db
      .query(
        `INSERT INTO triage_proposals (issue_id, actor, decision, duplicate_of_id, labels, assignee, priority, project_id, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (issue_id, actor) DO UPDATE SET decision = excluded.decision, duplicate_of_id = excluded.duplicate_of_id,
           labels = excluded.labels, assignee = excluded.assignee, priority = excluded.priority, project_id = excluded.project_id,
           reason = excluded.reason, updated_at = excluded.updated_at`,
      )
      .run(row.id, ctx.actor, input.decision, duplicateOfId, JSON.stringify(labels), assignee, input.priority ?? null, project?.id ?? null, reason, ts, ts);
    const proposal = toProposal(ctx.db.query(`${SELECT} WHERE p.issue_id = ? AND p.actor = ?`).get(row.id, ctx.actor) as ProposalRow);
    notifyTriageProposal(ctx.db, row.id, ctx.actor, { decision: proposal.decision, duplicateOf: proposal.duplicateOf });
    return proposal;
  });
}

// 自分の提案を取り下げる（#125）。他の書き手の提案は消せない。提案と同じく Triage 中の Issue だけが対象
export function withdrawTriageProposal(ctx: OpCtx, ref: string): { issueId: string; actor: string; withdrawn: true } {
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    requireTriage(row, ref);
    const issueId = formatIssueId(row.ws_key, row.number);
    const removed = ctx.db.query("DELETE FROM triage_proposals WHERE issue_id = ? AND actor = ?").run(row.id, ctx.actor).changes;
    if (removed === 0) throw new NodError("NOT_FOUND", `${issueId} に ${ctx.actor} の提案はありません`);
    clearUnreadTriageProposal(ctx.db, row.id, ctx.actor);
    return { issueId, actor: ctx.actor, withdrawn: true as const };
  });
}

// Triage 一覧のバッジ用（#125）。Triage 中の Issue ごとの提案者の数。提案の無い Issue は含めない
export function listTriageProposalCounts(db: Database): Record<string, number> {
  const rows = db
    .query(
      `SELECT w.key AS ws_key, i.number AS number, count(*) AS n FROM triage_proposals p
       JOIN issues i ON i.id = p.issue_id JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.status = 'triage' AND i.archived_at IS NULL GROUP BY p.issue_id`,
    )
    .all() as { ws_key: string; number: number; n: number }[];
  return Object.fromEntries(rows.map((r) => [formatIssueId(r.ws_key, r.number), r.n]));
}

// 読み取りのみ。更新の新しい順。人の確定後も残っている提案を返す
export function listTriageProposals(db: Database, ref: string): TriageProposal[] {
  const row = findIssueRow(db, ref);
  return (db.query(`${SELECT} WHERE p.issue_id = ? ORDER BY p.updated_at DESC, p.actor`).all(row.id) as ProposalRow[]).map(toProposal);
}
