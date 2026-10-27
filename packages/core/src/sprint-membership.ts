import { HUMAN_ACTOR } from "./ctx";
import type { Database } from "bun:sqlite";
import { NodError } from "./errors";

// 読取の共通条件。候補だけ、未採用・未合意の計画は所属に数えない。
export const AGREED_SPRINT_PLAN = `p.sprint_id=s.id AND p.id=s.adopted_plan_id
  AND p.agreed_by='${HUMAN_ACTOR}' AND p.agreed_at IS NOT NULL AND p.content_hash<>'' AND p.agreed_hash=p.content_hash`;
export const CURRENT_SPRINT = `s.phase='active' AND julianday(s.starts_at)<=julianday(?) AND julianday(s.ends_at)>julianday(?)`;
// 通常の着手経路から保護する集合。期限・設定・要求の変更で保護を解除しない。
// 終了後の未解決試行による保護は、試行管理を導入する際にここへ接続する。
export const MANAGED_SPRINT_ISSUE = `SELECT 1 FROM sprint_items si JOIN sprints s ON s.id=si.sprint_id
  JOIN sprint_plan_items pi ON pi.item_id=si.id JOIN sprint_plans p ON p.id=pi.plan_id
  WHERE si.issue_id=i.id AND s.phase IN ('ready','active') AND ${AGREED_SPRINT_PLAN}`;

export function assertOrdinaryIssueStart(db: Database, issueId: number): void {
  if (db.query(`SELECT 1 FROM issues i WHERE i.id=? AND EXISTS (${MANAGED_SPRINT_ISSUE})`).get(issueId)) {
    // S02は試行を保存しない。callerの自己申告contextでは管理対象の着手を許可しない。
    throw new NodError("SPRINT_CONTEXT_REQUIRED", "合意済みSprintの採択Issueです。対応する試行を照合できないため、通常経路からは着手できません");
  }
}
export const SPRINT_MEMBERSHIP = `SELECT 1 FROM sprint_items si JOIN sprints s ON s.id=si.sprint_id
  WHERE si.issue_id=i.id AND (
    (s.phase='imported' AND si.origin='imported') OR EXISTS (
      SELECT 1 FROM sprint_plan_items pi JOIN sprint_plans p ON p.id=pi.plan_id
      WHERE pi.item_id=si.id AND ${AGREED_SPRINT_PLAN}))`;
