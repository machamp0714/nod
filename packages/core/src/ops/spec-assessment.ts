import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { NodError } from "../errors";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { findIssueRow, toIssue } from "../issue-query";
import type { SpecAssessment } from "../types";
import { jevClient, JEV_MODEL, JEV_CRITERIA_VERSION, JEV_THRESHOLD, type JevClient, type JevResult } from "./jev-client";

export function specBodyHash(body: string | null): string {
  return createHash("sha256").update(body ?? "").digest("hex");
}

export function isWorkspaceSpecAssessmentEnabled(db: Database, workspaceId: number): boolean {
  const workspace = db.query("SELECT spec_assessment_enabled FROM workspaces WHERE id = ?").get(workspaceId) as { spec_assessment_enabled: number } | null;
  return workspace?.spec_assessment_enabled === 1;
}

// 呼び出し元の起票transaction内で保存する。既存Issueへの遡及はしない。
export function prepareCreatedIssueAssessment(ctx: OpCtx, issueId: number, workspaceId: number, body: string | null): void {
  if (!isWorkspaceSpecAssessmentEnabled(ctx.db, workspaceId)) return;
  const assessment: SpecAssessment = {
    status: "pending", generation: 1, bodyHash: specBodyHash(body), model: JEV_MODEL,
    criteriaVersion: JEV_CRITERIA_VERSION, threshold: JEV_THRESHOLD, requestedAt: now(), finishedAt: null,
    probability: null, inputTokens: null, elapsedMs: null, failureKind: null,
  };
  ctx.db.query("UPDATE issues SET spec_assessment = ? WHERE id = ?").run(JSON.stringify(assessment), issueId);
}

export async function assessCreatedIssue(ctx: OpCtx, ref: string, client: JevClient = jevClient) {
  const row = findIssueRow(ctx.db, ref);
  const assessment = toIssue(row).specAssessment;
  if (!assessment || assessment.status !== "pending" || !isWorkspaceSpecAssessmentEnabled(ctx.db, row.workspace_id)) return toIssue(row);
  let result: JevResult;
  try { result = await client(row.description ?? ""); }
  catch { result = { kind: "failed", failureKind: "network", elapsedMs: 0 }; }
  return tx(ctx.db, () => {
    const current = findIssueRow(ctx.db, ref);
    const live = toIssue(current).specAssessment;
    if (!live || live.generation !== assessment.generation || live.status !== "pending") return toIssue(current);
    const enabled = isWorkspaceSpecAssessmentEnabled(ctx.db, current.workspace_id);
    if (!enabled || current.archived_at || ["done", "canceled"].includes(current.status)) {
      invalidateIssueAssessment(ctx, current.id, !enabled ? "disabled" : "inactive", true);
      return toIssue(findIssueRow(ctx.db, ref));
    }
    const updated: SpecAssessment = {
      ...live, status: result.kind === "success" ? "completed" : "failed", finishedAt: now(), elapsedMs: result.elapsedMs,
      probability: result.kind === "success" ? result.probability : null,
      inputTokens: result.kind === "success" ? result.inputTokens : null,
      failureKind: result.kind === "failed" ? result.failureKind : null,
    };
    ctx.db.query("UPDATE issues SET spec_assessment = ? WHERE id = ?").run(JSON.stringify(updated), current.id);
    if (result.kind === "success" && result.probability >= assessment.threshold && !live.recordOnly && !live.labelEdited) {
      ctx.db.query("INSERT OR IGNORE INTO issue_labels (issue_id, label) VALUES (?, 'needs-spec')").run(current.id);
    }
    return toIssue(findIssueRow(ctx.db, ref));
  });
}

// 明示再試行だけが新しい要求を開始する。過去の結果は履歴として保持する。
export async function retryIssueAssessment(ctx: OpCtx, ref: string, client: JevClient = jevClient) {
  tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    if (!isWorkspaceSpecAssessmentEnabled(ctx.db, row.workspace_id)) throw new NodError("INVALID_ARGS", "Workspace の自動仕様判定は無効です");
    if (row.archived_at || ["done", "canceled"].includes(row.status)) throw new NodError("INVALID_ARGS", "完了・キャンセル・アーカイブ済みのIssueは判定できません");
    const old = toIssue(row).specAssessment;
    const { history = [], ...previous } = old ?? {} as SpecAssessment;
    const next: SpecAssessment = {
      status: "pending", generation: (old?.generation ?? 0) + 1,
      bodyHash: specBodyHash(row.description), model: JEV_MODEL, criteriaVersion: JEV_CRITERIA_VERSION,
      threshold: JEV_THRESHOLD, requestedAt: now(), finishedAt: null,
      probability: null, inputTokens: null, elapsedMs: null, failureKind: null,
      history: old ? [...history, previous as Omit<SpecAssessment, "history">] : [],
      recordOnly: old?.recordOnly || old?.status === "completed",
      labelEdited: old?.labelEdited,
    };
    ctx.db.query("UPDATE issues SET spec_assessment = ? WHERE id = ?").run(JSON.stringify(next), row.id);
  });
  return assessCreatedIssue(ctx, ref, client);
}

// 本文が戻っても過去の要求を適用しないため、hashだけでなく世代も更新する。
export function invalidateIssueAssessment(ctx: OpCtx, issueId: number, failureKind: "stale" | "disabled" | "inactive", suspended = false) {
  const row = ctx.db.query("SELECT spec_assessment FROM issues WHERE id = ?").get(issueId) as { spec_assessment: string | null };
  if (!row.spec_assessment) return;
  const assessment: SpecAssessment = JSON.parse(row.spec_assessment);
  if (assessment.status !== "pending") {
    if (suspended && assessment.status === "failed") {
      ctx.db.query("UPDATE issues SET spec_assessment = ? WHERE id = ?").run(JSON.stringify({ ...assessment, suspended: true }), issueId);
    }
    return;
  }
  const { history = [], ...previous } = assessment;
  ctx.db.query("UPDATE issues SET spec_assessment = ? WHERE id = ?").run(JSON.stringify({
    ...assessment, history: [...history, previous], generation: assessment.generation + 1,
    status: "failed", failureKind, finishedAt: now(), suspended,
  }), issueId);
}
