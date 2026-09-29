import type { Database } from "bun:sqlite";
import { now } from "../ctx";
import { NodError } from "../errors";
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
    const activity = db.query(`WITH target AS (SELECT id FROM issues WHERE workspace_id = ? AND number = ?)
      SELECT created_at AS at FROM events WHERE issue_id IN target
      UNION ALL SELECT created_at FROM comments WHERE issue_id IN target
      UNION ALL SELECT asked_at FROM questions WHERE issue_id IN target
      UNION ALL SELECT answered_at FROM questions WHERE issue_id IN target`);
    const findings: IssueDiagnosis[] = [];
    for (const issue of issues) {
      const timestamps = [issue.createdAt, issue.updatedAt,
        ...(activity.all(opts.workspaceId, issue.number) as { at: string | null }[]).map(row => row.at)];
      let latest: number | null = null;
      for (const timestamp of timestamps) {
        const value = recordedTimestamp(timestamp);
        if (value !== null && (latest === null || value > latest)) latest = value;
      }
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
