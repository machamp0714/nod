import type { Database } from "bun:sqlite";
import { SPRINT_ITEM_MEMBER } from "../sprint-membership";
import type { SprintClosureRecord } from "../sprint-types";

// 呼出し元の状態変更と同じtransactionで、共通の所属条件に入るIssueだけを記録する。
// 計画にない追加のIssueも含め、候補として登録しただけのitemは含めない。
export function saveSprintClosure(db: Database, sprintId: string, kind: SprintClosureRecord["kind"], reason: string, recordedAt: string,
  automation?: SprintClosureRecord["automation"]): void {
  const members = `FROM sprints s JOIN sprint_items si ON si.sprint_id=s.id
    JOIN issues i ON i.id=si.issue_id`;
  const issues = db.query(`SELECT si.source_issue_key AS issueId,i.status ${members}
    WHERE s.id=? AND ${SPRINT_ITEM_MEMBER} AND i.status NOT IN ('done','canceled') ORDER BY i.id`).all(sprintId) as SprintClosureRecord["issues"];
  const questions = db.query(`SELECT q.id AS questionId,si.source_issue_key AS issueId ${members}
    JOIN questions q ON q.issue_id=i.id WHERE s.id=? AND ${SPRINT_ITEM_MEMBER} AND q.answer IS NULL ORDER BY q.id`).all(sprintId) as SprintClosureRecord["questions"];
  const record: SprintClosureRecord = { kind, recordedAt, reason, issues, questions, ...(automation ? { automation } : {}) };
  db.query("UPDATE sprints SET closure_record=? WHERE id=?").run(JSON.stringify(record), sprintId);
}
