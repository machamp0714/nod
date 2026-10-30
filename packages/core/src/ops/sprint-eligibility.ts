import { HUMAN_ACTOR, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { findIssueRow, OPEN_BLOCKER, toIssue } from "../issue-query";
import { sprintHash } from "../sprint-validation";
import { transitionViolation, transitionViolationMessage } from "../transition-rules";
import type { SprintClock } from "../sprint-types";
import { isWorkspaceSpecAssessmentEnabled } from "./spec-assessment";
import { getSprint } from "./sprints";

export interface SprintIssueEligibility {
  sprintId: string;
  sprintVersion: number;
  planId: string | null;
  planHash: string | null;
  itemId: string;
  issueId: string | null;
  eligible: boolean;
  reason: { code: string; message: string } | null;
}

// 採択とIssueの着手条件の読取判定。実行許可・予約ではない。
// S03は予約時と実装開始時のtransaction内でこれを再確認し、保存した試行・所有も照合する。
export function getSprintIssueEligibility(ctx: OpCtx, ref: string, itemId: string, clock: SprintClock = {}): SprintIssueEligibility {
  return tx(ctx.db, () => {
    const sprint = getSprint(ctx.db, ref);
    const candidate = sprint.items.find(item => item.id === itemId);
    if (!candidate) throw new NodError("NOT_FOUND", "対象Sprintにitemがありません");
    const plan = sprint.plans.find(plan => plan.id === sprint.adoptedPlanId);
    const result = { sprintId: sprint.id, sprintVersion: sprint.version, planId: plan?.id ?? null,
      planHash: plan?.contentHash ?? null, itemId, issueId: candidate.issueId === null ? null : candidate.sourceIssueKey };
    const blocked = (code: string, message: string): SprintIssueEligibility => ({ ...result, eligible: false, reason: { code, message } });
    const selected = plan?.content.items.find(item => item.itemId === itemId);
    if (!plan || plan.agreedBy !== HUMAN_ACTOR || !plan.agreedAt || !plan.contentHash || plan.agreedHash !== plan.contentHash || !selected) {
      return blocked("NOT_ACCEPTED", "採用中の合意済み計画に採択されていません");
    }
    if (sprint.phase !== "active") return blocked("SPRINT_NOT_ACTIVE", "Sprintは実行中ではありません");
    const config = sprint.workspaceId === null ? null : ctx.db.query("SELECT enabled FROM scrum_workspaces WHERE workspace_id=?").get(sprint.workspaceId) as { enabled: number } | null;
    if (!config?.enabled) return blocked("SCRUM_DISABLED", "WorkspaceのSprint運用が無効です");
    const instant = clock.now ?? new Date();
    if (!Number.isFinite(instant.getTime())) throw new NodError("INVALID_ARGS", "時計の時刻が不正です");
    if (!sprint.startsAt || instant.getTime() < Date.parse(sprint.startsAt)) return blocked("SPRINT_NOT_ACTIVE", "Sprintの開始期間前です");
    if (!sprint.endsAt || instant.getTime() >= Date.parse(sprint.endsAt)) return blocked("SPRINT_EXPIRED", "Sprintの期間は終了しています");
    if (candidate.issueId === null) return blocked("TARGET_CHANGED", "採択したIssueが削除されています");
    const issue = findIssueRow(ctx.db, candidate.sourceIssueKey);
    if (issue.archived_at) return blocked("ISSUE_ARCHIVED", "採択したIssueはアーカイブされています");
    const period = plan.content.period;
    if (sprintHash(plan.content) !== plan.contentHash || period.startDate !== sprint.startDate || period.endDate !== sprint.endDate
      || period.timezone !== sprint.timezone || period.startsAt !== sprint.startsAt || period.endsAt !== sprint.endsAt
      || JSON.stringify(period.workingDays) !== JSON.stringify(sprint.workingDays)
      || issue.id !== candidate.issueId || issue.workspace_id !== sprint.workspaceId
      || issue.title !== selected.requirement.title || issue.description !== selected.requirement.description) {
      return blocked("TARGET_CHANGED", "採択した要求または期間が合意した計画と異なります");
    }
    const assessment = toIssue(issue).specAssessment;
    if (isWorkspaceSpecAssessmentEnabled(ctx.db, issue.workspace_id) && assessment && !assessment.suspended && !assessment.recordOnly && assessment.status !== "completed") {
      return blocked("SPEC_ASSESSMENT_REQUIRED", "仕様要否判定が未完了です");
    }
    if (issue.status === "triage") return blocked("NOT_ACCEPTED", "IssueはTriageにあります");
    if (issue.status === "needs_clarification") return blocked("NEEDS_CLARIFICATION", "Issueの未決事項が残っています");
    if (issue.status === "done" || issue.status === "canceled") return blocked("ISSUE_CLOSED", "Issueは終了しています");
    if (issue.assignee && issue.assignee !== ctx.actor) return blocked("ASSIGNED_TO_OTHER", "別の担当者が所有しています");
    if (ctx.db.query("SELECT 1 FROM questions WHERE issue_id=? AND answer IS NULL").get(issue.id)) return blocked("AWAITING_ANSWER", "未回答の確認依頼があります");
    if (ctx.db.query(`SELECT 1 FROM relations r JOIN issues b ON b.id=r.from_id WHERE r.to_id=? AND r.type='blocks' AND ${OPEN_BLOCKER}`).get(issue.id)) {
      return blocked("BLOCKED", "未解決の依存関係があります");
    }
    if (toIssue(issue).labels.includes("needs-spec")) return blocked("NEEDS_SPEC", "仕様書の準備が必要です");
    if (issue.snoozed_until && Date.parse(issue.snoozed_until) > instant.getTime()) return blocked("ISSUE_SNOOZED", "スヌーズ期間中です");
    const violation = transitionViolation(ctx.db, issue.workspace_id, issue.status, "in_progress");
    if (violation) return blocked("TRANSITION_NOT_ALLOWED", transitionViolationMessage(ctx.db, issue.ws_key, issue.status, "in_progress", violation));
    return { ...result, eligible: true, reason: null };
  });
}
