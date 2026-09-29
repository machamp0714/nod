import type { Database } from "bun:sqlite";
import { now } from "../ctx";
import { NodError } from "../errors";
import { latestActivity } from "../activity";
import { recordedTimestamp } from "../recorded-time";
import type { Issue } from "../types";
import { listIssues } from "./issues";

const DAY_MS = 86_400_000;
export type DiagnosisReason = { type: "blocked"; blockedBy: string[] } | { type: "stale"; inactiveDays: number };
export interface IssueDiagnosis {
  issue: Issue;
  lastActivityAt: string | null;
  reasons: DiagnosisReason[];
}
export interface Diagnosis {
  evaluatedAt: string;
  staleDays: number;
  findings: IssueDiagnosis[];
}

export function validateStaleDays(days: number): void {
  if (!Number.isSafeInteger(days) || days <= 0 || !Number.isSafeInteger(days * DAY_MS)) {
    throw new NodError("INVALID_ARGS", "--stale-days は経過時間を正確に表せる正の整数で指定してください");
  }
}

// 活動記録がない候補を返す。実際の作業停止は断定せず、状態・担当・eventを更新しない。
export function diagnoseIssues(db: Database, opts: {
  workspaceId: number;
  projectRef?: string;
  staleDays: number;
  evaluatedAt?: string;
}): Diagnosis {
  validateStaleDays(opts.staleDays);
  const evaluatedAt = opts.evaluatedAt ?? now();
  const current = recordedTimestamp(evaluatedAt);
  if (current === null) throw new NodError("INVALID_ARGS", "診断の基準日時が正しくありません");
  return db.transaction(() => {
    const issues = listIssues(db, { workspaceId: opts.workspaceId, projectRef: opts.projectRef });
    // 最後の活動は内部の id で引く（Issue ごとに引き直さないよう、番号から一度に対応づける）
    const internalIds = new Map(
      (db.query("SELECT id, number FROM issues WHERE workspace_id = ?").all(opts.workspaceId) as { id: number; number: number }[])
        .map((row) => [row.number, row.id]),
    );
    const findings: IssueDiagnosis[] = [];
    for (const issue of issues) {
      const latest = latestActivity(db, internalIds.get(issue.number)!, issue.createdAt, issue.updatedAt);
      const reasons: DiagnosisReason[] = [];
      if (issue.blockedBy.length) reasons.push({ type: "blocked", blockedBy: issue.blockedBy });
      const snoozedUntil = recordedTimestamp(issue.snoozedUntil);
      if (["in_progress", "in_review", "needs_clarification"].includes(issue.status)
        && !(snoozedUntil !== null && snoozedUntil > current)
        && latest !== null && current - latest >= opts.staleDays * DAY_MS) {
        reasons.push({ type: "stale", inactiveDays: Math.floor((current - latest) / DAY_MS) });
      }
      if (reasons.length) findings.push({ issue, lastActivityAt: latest === null ? null : new Date(latest).toISOString(), reasons });
    }
    return { evaluatedAt, staleDays: opts.staleDays, findings };
  })();
}
