import { HUMAN_ACTOR } from "./ctx";

// 読取の共通条件。候補だけ、未採用・未合意の計画は所属に数えない。
export const AGREED_SPRINT_PLAN = `p.sprint_id=s.id AND p.id=s.adopted_plan_id
  AND p.agreed_by='${HUMAN_ACTOR}' AND p.agreed_at IS NOT NULL AND p.content_hash<>'' AND p.agreed_hash=p.content_hash`;
export const CURRENT_SPRINT = `s.phase='active' AND julianday(s.starts_at)<=julianday(?) AND julianday(s.ends_at)>julianday(?)`;
export const SPRINT_MEMBERSHIP = `SELECT 1 FROM sprint_items si JOIN sprints s ON s.id=si.sprint_id
  WHERE si.issue_id=i.id AND (
    (s.phase='imported' AND si.origin='imported') OR EXISTS (
      SELECT 1 FROM sprint_plan_items pi JOIN sprint_plans p ON p.id=pi.plan_id
      WHERE pi.item_id=si.id AND ${AGREED_SPRINT_PLAN}))`;
