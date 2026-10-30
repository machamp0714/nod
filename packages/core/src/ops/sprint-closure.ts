import type { Database } from "bun:sqlite";
import { AGREED_SPRINT_PLAN } from "../sprint-membership";
import type { SprintClosureRecord } from "../sprint-types";

// 呼出し元の状態変更と同じtransactionで、採用中の合意済み計画だけを記録する。
export function saveSprintClosure(db: Database, sprintId: string, kind: SprintClosureRecord["kind"], reason: string, recordedAt: string): void {
  const members = `FROM sprints s JOIN sprint_plans p ON ${AGREED_SPRINT_PLAN}
    JOIN sprint_plan_items pi ON pi.plan_id=p.id
    JOIN sprint_items si ON si.id=pi.item_id AND si.sprint_id=s.id
    JOIN issues i ON i.id=si.issue_id`;
  const issues = db.query(`SELECT si.source_issue_key AS issueId,i.status ${members}
    WHERE s.id=? AND i.status NOT IN ('done','canceled') ORDER BY i.id`).all(sprintId) as SprintClosureRecord["issues"];
  const questions = db.query(`SELECT q.id AS questionId,si.source_issue_key AS issueId ${members}
    JOIN questions q ON q.issue_id=i.id WHERE s.id=? AND q.answer IS NULL ORDER BY q.id`).all(sprintId) as SprintClosureRecord["questions"];
  const record: SprintClosureRecord = { kind, recordedAt, reason, issues, questions };
  db.query("UPDATE sprints SET closure_record=? WHERE id=?").run(JSON.stringify(record), sprintId);
}
