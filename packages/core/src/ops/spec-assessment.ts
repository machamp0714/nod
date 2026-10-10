import { createHash } from "node:crypto";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { findIssueRow, toIssue } from "../issue-query";
import type { SpecAssessment } from "../types";
import { jevClient, JEV_MODEL, JEV_CRITERIA_VERSION, JEV_THRESHOLD, type JevClient, type JevResult } from "./jev-client";

export function specBodyHash(body: string | null): string {
  return createHash("sha256").update(body ?? "").digest("hex");
}

// 呼び出し元の起票transaction内で保存する。既存Issueへの遡及はしない。
export function prepareCreatedIssueAssessment(ctx: OpCtx, issueId: number, workspaceId: number, body: string | null): void {
  const ws = ctx.db.query("SELECT spec_assessment_enabled FROM workspaces WHERE id = ?").get(workspaceId) as { spec_assessment_enabled: number };
  if (!ws.spec_assessment_enabled) return;
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
  const enabled = ctx.db.query("SELECT spec_assessment_enabled FROM workspaces WHERE id = ?").get(row.workspace_id) as { spec_assessment_enabled: number };
  if (!assessment || assessment.status !== "pending" || !enabled.spec_assessment_enabled) return toIssue(row);
  let result: JevResult;
  try { result = await client(row.description ?? ""); }
  catch { result = { kind: "failed", failureKind: "network", elapsedMs: 0 }; }
  return tx(ctx.db, () => {
    const current = findIssueRow(ctx.db, ref);
    const updated: SpecAssessment = {
      ...assessment, status: result.kind === "success" ? "completed" : "failed", finishedAt: now(), elapsedMs: result.elapsedMs,
      probability: result.kind === "success" ? result.probability : null,
      inputTokens: result.kind === "success" ? result.inputTokens : null,
      failureKind: result.kind === "failed" ? result.failureKind : null,
    };
    ctx.db.query("UPDATE issues SET spec_assessment = ? WHERE id = ?").run(JSON.stringify(updated), current.id);
    if (result.kind === "success" && result.probability >= assessment.threshold) {
      ctx.db.query("INSERT OR IGNORE INTO issue_labels (issue_id, label) VALUES (?, 'needs-spec')").run(current.id);
    }
    return toIssue(findIssueRow(ctx.db, ref));
  });
}
