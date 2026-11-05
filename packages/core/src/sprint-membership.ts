import { HUMAN_ACTOR } from "./ctx";

// 読取の共通条件。候補だけ、未採用・未合意の計画は所属に数えない。
export const AGREED_SPRINT_PLAN = `p.sprint_id=s.id AND p.id=s.adopted_plan_id
  AND p.agreed_by='${HUMAN_ACTOR}' AND p.agreed_at IS NOT NULL AND p.content_hash<>'' AND p.agreed_hash=p.content_hash`;
export const CURRENT_SPRINT = `s.phase='active' AND julianday(s.starts_at)<=julianday(?) AND julianday(s.ends_at)>julianday(?)`;
// itemが所属かどうか（si=sprint_items、s=sprints）。移行した履歴、採用中で人が合意した計画の項目、
// 追加の記録（追加者と追加時刻の両方）があるitemを所属とする。候補として登録しただけのitemは数えない。
export const SPRINT_ITEM_MEMBER = `((s.phase='imported' AND si.origin='imported')
    OR (si.added_by IS NOT NULL AND si.added_at IS NOT NULL)
    OR EXISTS (
      SELECT 1 FROM sprint_plan_items pi JOIN sprint_plans p ON p.id=pi.plan_id
      WHERE pi.item_id=si.id AND ${AGREED_SPRINT_PLAN}))`;
export const SPRINT_MEMBERSHIP = `SELECT 1 FROM sprint_items si JOIN sprints s ON s.id=si.sprint_id
  WHERE si.issue_id=i.id AND ${SPRINT_ITEM_MEMBER}`;
