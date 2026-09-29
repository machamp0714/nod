import type { Database } from "bun:sqlite";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { findIssueRow, findWritableIssueRow, formatIssueId, type IssueRow } from "../issue-query";
import { setColumn } from "../mutate";
import type { AutoTransition, AutoTransitionSource, PrState, Status } from "../types";

// PR・コミットによる自動遷移（#66・#68）。進める先は in_review だけで、done にはしない（完了は人がレビューで決める）。
// 同じ Issue・同じ PR URL（コミット SHA）では一度だけ遷移させる。差し戻しや取消のあとも、記録が残るので再び進めない。
// PR 連動は、現在の PR を付けたあとに一度でも in_review になった、または in_review から動いた Issue（nod issue done 済み・差し戻し後）も進めない
export const PR_REVIEW_FROM: Status[] = ["in_progress"];

interface TransitionRow {
  id: number;
  issue_id: number;
  source: AutoTransitionSource;
  source_key: string;
  from_status: Status;
  to_status: Status;
  merge_candidate: number;
  actor: string;
  created_at: string;
  reverted_at: string | null;
  reverted_by: string | null;
}

const TRANSITION_SELECT = `SELECT t.*, w.key AS ws_key, i.number FROM auto_transitions t
  JOIN issues i ON i.id = t.issue_id JOIN workspaces w ON w.id = i.workspace_id`;

function toTransition(r: TransitionRow & { ws_key: string; number: number }): AutoTransition {
  return {
    id: r.id,
    issueId: formatIssueId(r.ws_key, r.number),
    source: r.source,
    sourceKey: r.source_key,
    from: r.from_status,
    to: r.to_status,
    mergeCandidate: r.merge_candidate === 1,
    actor: r.actor,
    createdAt: r.created_at,
    revertedAt: r.reverted_at,
    revertedBy: r.reverted_by,
  };
}

function transitionById(db: Database, id: number): AutoTransition {
  return toTransition(db.query(`${TRANSITION_SELECT} WHERE t.id = ?`).get(id) as TransitionRow & { ws_key: string; number: number });
}

export function listAutoTransitions(db: Database, ref: string): AutoTransition[] {
  const row = findIssueRow(db, ref);
  const rows = db.query(`${TRANSITION_SELECT} WHERE t.issue_id = ? ORDER BY t.id`).all(row.id) as (TransitionRow & {
    ws_key: string;
    number: number;
  })[];
  return rows.map(toTransition);
}

export function hasAutoTransition(db: Database, issueRowId: number, source: AutoTransitionSource, sourceKey: string): boolean {
  return db.query("SELECT 1 FROM auto_transitions WHERE issue_id = ? AND source = ? AND source_key = ?").get(issueRowId, source, sourceKey) !== null;
}

// PR 状態が in_review に進める条件を満たすか。open かつ draft でない、またはマージ済み。
// レビューの判定（reviewDecision）は見ない（個人運用ではレビュー依頼がないことが多いため）
export function prReadyForReview(state: PrState, isDraft: boolean): boolean {
  return (state === "OPEN" && !isDraft) || state === "MERGED";
}

export function prReviewReason(state: PrState): string {
  return state === "MERGED" ? "PR がマージ済み（完了候補。done にするかは人が判断）" : "PR がレビュー待ち（open・draft 以外）";
}

// 呼び出し側の transaction の中で使う。status を in_review にし、作業状況は手動移動と同じく done 以外なら外す
export function applyAutoTransition(
  ctx: OpCtx,
  row: IssueRow,
  input: { source: AutoTransitionSource; sourceKey: string; reason: string; automation: string; mergeCandidate?: boolean },
): AutoTransition {
  const from = row.status as Status;
  setColumn(ctx, row, "status", "in_review", { reason: input.reason, automation: input.automation });
  if (row.agent_state !== "done") setColumn(ctx, row, "agent_state", null);
  const { lastInsertRowid } = ctx.db
    .query(
      `INSERT INTO auto_transitions (issue_id, source, source_key, from_status, to_status, merge_candidate, actor, created_at)
       VALUES (?, ?, ?, ?, 'in_review', ?, ?, ?)`,
    )
    .run(row.id, input.source, input.sourceKey, from, input.mergeCandidate ? 1 : 0, ctx.actor, now());
  return transitionById(ctx.db, Number(lastInsertRowid));
}

// PR 連動が有効な Workspace で、保存済みの PR 状態（issue の現在の PR URL のもの）が条件を満たせば in_review に進める。
// 呼び出し側の transaction の中で使う。進めなければ null
export function applyPrReview(ctx: OpCtx, issueRowId: number): AutoTransition | null {
  const target = prReviewTarget(ctx.db, issueRowId);
  if (!target) return null;
  const row = findIssueRow(ctx.db, formatIssueId(target.ws_key, target.number));
  return applyAutoTransition(ctx, row, {
    source: "pr",
    sourceKey: target.pr_url,
    reason: prReviewReason(target.state),
    automation: "pr_review",
    mergeCandidate: target.state === "MERGED",
  });
}

interface PrReviewRow {
  id: number;
  number: number;
  title: string;
  status: Status;
  ws_key: string;
  pr_url: string;
  data: string;
  fetched_at: string;
}

const PR_REVIEW_SELECT = `SELECT i.id, i.number, i.title, i.status, w.key AS ws_key, i.pr_url, p.data, p.fetched_at
  FROM issues i JOIN workspaces w ON w.id = i.workspace_id JOIN pr_statuses p ON p.issue_id = i.id
  WHERE w.pr_review_enabled = 1 AND i.archived_at IS NULL
    AND i.status IN (${PR_REVIEW_FROM.map((s) => `'${s}'`).join(", ")})
    AND p.data IS NOT NULL AND p.pr_url = i.pr_url
    AND NOT EXISTS (SELECT 1 FROM auto_transitions t WHERE t.issue_id = i.id AND t.source = 'pr' AND t.source_key = i.pr_url)
    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.issue_id = i.id AND e.type = 'status_changed'
      AND json_extract(e.data, '$.to') = 'in_review' AND (i.pr_linked_at IS NULL OR e.created_at >= i.pr_linked_at))
    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.issue_id = i.id AND e.type = 'status_changed'
      AND json_extract(e.data, '$.from') = 'in_review' AND (i.pr_linked_at IS NULL OR e.created_at >= i.pr_linked_at))`;

export interface PrReviewTarget extends PrReviewRow {
  state: PrState;
}

function withState(rows: PrReviewRow[]): PrReviewTarget[] {
  const out: PrReviewTarget[] = [];
  for (const r of rows) {
    const data = JSON.parse(r.data) as { state: PrState; isDraft: boolean };
    if (prReadyForReview(data.state, data.isDraft)) out.push({ ...r, state: data.state });
  }
  return out;
}

function prReviewTarget(db: Database, issueRowId: number): PrReviewTarget | null {
  return withState(db.query(`${PR_REVIEW_SELECT} AND i.id = ?`).all(issueRowId) as PrReviewRow[])[0] ?? null;
}

// 自動化の実行（nod automation run）で使う。PR 連動が有効な Workspace の、条件を満たす Issue（古く取得した順）
export function prReviewTargets(db: Database, workspaceId: number, issueRowId?: number): PrReviewTarget[] {
  const rows = db
    .query(`${PR_REVIEW_SELECT} AND i.workspace_id = ? ${issueRowId === undefined ? "" : "AND i.id = ?"} ORDER BY p.fetched_at, i.number`)
    .all(workspaceId, ...(issueRowId === undefined ? [] : [issueRowId])) as PrReviewRow[];
  return withState(rows);
}

// その Issue の最新の未取消の自動遷移を取り消す。Issue がまだ遷移先（in_review）で、自動遷移のあとに状態が変わっていないときだけ
// 元の状態に戻す（me だけ）。戻すのは status だけで、自動遷移で外した作業状況（agent_state）は戻さない
export function undoAutoTransition(ctx: OpCtx, ref: string): AutoTransition {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は自動遷移を取り消せません。取消は me に依頼してください");
  }
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    const id = formatIssueId(row.ws_key, row.number);
    const t = ctx.db
      .query("SELECT * FROM auto_transitions WHERE issue_id = ? AND reverted_at IS NULL ORDER BY id DESC LIMIT 1")
      .get(row.id) as TransitionRow | null;
    if (!t) throw new NodError("NOT_FOUND", `${id} に取り消せる自動遷移はありません`);
    if (row.status !== t.to_status) {
      throw new NodError("NOT_IN_REVIEW", `${id} はすでに ${row.status} なので取り消せません（自動遷移の取消は ${t.to_status} のときだけ）`);
    }
    const changedAfter = ctx.db
      .query("SELECT 1 FROM events WHERE issue_id = ? AND type = 'status_changed' AND created_at > ? LIMIT 1")
      .get(row.id, t.created_at);
    if (changedAfter) {
      throw new NodError("INVALID_STATE", `${id} は自動遷移の後に状態が変わっています。取り消せません（状態は手動で変えてください）`);
    }
    const what = t.source === "pr" ? `PR ${t.source_key}` : `コミット ${t.source_key.slice(0, 12)}`;
    setColumn(ctx, row, "status", t.from_status, { reason: `自動遷移の取消（${what}）`, automation: "undo" });
    ctx.db.query("UPDATE auto_transitions SET reverted_at = ?, reverted_by = ? WHERE id = ?").run(now(), ctx.actor, t.id);
    return transitionById(ctx.db, t.id);
  });
}
