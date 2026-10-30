import { HUMAN_ACTOR } from "./ctx";
import type { Database } from "bun:sqlite";
import { NodError } from "./errors";

// 読取の共通条件。候補だけ、未採用・未合意の計画は所属に数えない。
export const AGREED_SPRINT_PLAN = `p.sprint_id=s.id AND p.id=s.adopted_plan_id
  AND p.agreed_by='${HUMAN_ACTOR}' AND p.agreed_at IS NOT NULL AND p.content_hash<>'' AND p.agreed_hash=p.content_hash`;
export const CURRENT_SPRINT = `s.phase='active' AND julianday(s.starts_at)<=julianday(?) AND julianday(s.ends_at)>julianday(?)`;
// 通常の着手経路から保護する集合。期限・設定・要求の変更で保護を解除しない。
// 終了・中止や合意の更新後も、未解決の実行を通常経路へ重ねて引き取らない。
export const MANAGED_SPRINT_ISSUE = `SELECT 1 FROM sprint_items si JOIN sprints s ON s.id=si.sprint_id
  WHERE si.issue_id=i.id AND (EXISTS (
    SELECT 1 FROM sprint_plan_items pi JOIN sprint_plans p ON p.id=pi.plan_id
    WHERE pi.item_id=si.id AND s.phase IN ('ready','active') AND ${AGREED_SPRINT_PLAN})
    OR EXISTS (SELECT 1 FROM sprint_attempts a WHERE a.item_id=si.id AND a.occupied=1)
    OR EXISTS (SELECT 1 FROM sprint_sessions ss, json_each(ss.payload,'$.unreconciledOwnership') owned
      WHERE ss.sprint_id=s.id AND json_extract(owned.value,'$.itemId')=si.id))`;

export function assertOrdinaryIssueStart(db: Database, issueId: number): void {
  if (db.query(`SELECT 1 FROM issues i WHERE i.id=? AND EXISTS (${MANAGED_SPRINT_ISSUE})`).get(issueId)) {
    // callerの自己申告context・許可flagは実行許可の根拠にしない。
    throw new NodError("SPRINT_CONTEXT_REQUIRED", "合意済みSprintまたは未解決の試行が管理中です。元Task・Dispatchと予約を照合してください");
  }
}
export const SPRINT_MEMBERSHIP = `SELECT 1 FROM sprint_items si JOIN sprints s ON s.id=si.sprint_id
  WHERE si.issue_id=i.id AND (
    (s.phase='imported' AND si.origin='imported') OR EXISTS (
      SELECT 1 FROM sprint_plan_items pi JOIN sprint_plans p ON p.id=pi.plan_id
      WHERE pi.item_id=si.id AND ${AGREED_SPRINT_PLAN}))`;
