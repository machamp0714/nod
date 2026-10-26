import type { Database } from "bun:sqlite";
import { NodError } from "../errors";
import { selectIssues } from "../issue-query";
import { AGREED_SPRINT_PLAN as AGREED_PLAN, CURRENT_SPRINT, SPRINT_MEMBERSHIP } from "../sprint-membership";
import type { CurrentSprintResolution, LegacyCycleResolution, Sprint, SprintClock, SprintDetail, SprintItem, SprintLegacyEvent, SprintPhase } from "../sprint-types";

interface SprintRow {
  id: string; number: number; workspace_id: number | null; name: string; phase: SprintPhase;
  start_date: string; end_date: string; timezone: string | null; starts_at: string | null; ends_at: string | null;
  adopted_plan_id: string | null; goal: string | null; definition_of_done: string | null; outcome: string | null;
  legacy_cycle_id: number | null; legacy_data: string | null; created_at: string; updated_at: string;
}

function toSprint(r: SprintRow): Sprint {
  return {
    id: r.id, number: r.number, workspaceId: r.workspace_id, name: r.name, phase: r.phase,
    startDate: r.start_date, endDate: r.end_date, timezone: r.timezone, startsAt: r.starts_at, endsAt: r.ends_at,
    adoptedPlanId: r.adopted_plan_id, goal: r.goal, definitionOfDone: r.definition_of_done, outcome: r.outcome,
    legacyCycleId: r.legacy_cycle_id, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function listSprints(db: Database, filter: { workspaceId?: number } = {}): Sprint[] {
  const rows = filter.workspaceId === undefined
    ? db.query("SELECT * FROM sprints ORDER BY number").all()
    : db.query("SELECT * FROM sprints WHERE workspace_id=? ORDER BY number").all(filter.workspaceId);
  return (rows as SprintRow[]).map(toSprint);
}

// 新しい数値参照は共通番号。旧URLの数値参照は resolveLegacyCycle で解決する。
export function resolveSprint(db: Database, ref: string): Sprint {
  const value = ref.trim();
  const row = db.query(`SELECT * FROM sprints WHERE ${/^[1-9]\d*$/.test(value) ? "number" : "id"}=?`)
    .get(/^[1-9]\d*$/.test(value) ? Number(value) : value) as SprintRow | null;
  if (!row) throw new NodError("NOT_FOUND", `Sprint ${ref} はありません`);
  return toSprint(row);
}

export function resolveLegacyCycle(db: Database, cycleId: number): LegacyCycleResolution {
  const row = db.query("SELECT kind,sprint_id FROM sprint_legacy_refs WHERE cycle_id=?").get(cycleId) as {kind: "imported" | "deleted"; sprint_id: string | null} | null;
  if (!row) return {kind: "not_found"};
  return row.kind === "imported" && row.sprint_id ? {kind: "imported", sprintId: row.sprint_id} : {kind: "deleted"};
}

export function getSprint(db: Database, ref: string): SprintDetail {
  const sprint = resolveSprint(db, ref);
  const row = db.query("SELECT legacy_data FROM sprints WHERE id=?").get(sprint.id) as {legacy_data: string | null};
  const items = db.query("SELECT * FROM sprint_items WHERE sprint_id=? ORDER BY source_issue_key").all(sprint.id) as {
    id: string; sprint_id: string; issue_id: number | null; source_issue_key: string; origin: SprintItem["origin"]; snapshot: string;
  }[];
  const events = db.query(`SELECT e.original,r.association FROM sprint_legacy_event_refs r
    JOIN sprint_legacy_events e ON e.event_id=r.event_id WHERE r.cycle_id=? ORDER BY e.event_id`).all(sprint.legacyCycleId) as {original: string; association: SprintLegacyEvent["association"]}[];
  const evidence=db.query('SELECT * FROM sprint_legacy_issue_evidence WHERE sprint_id=? ORDER BY source_issue_key').all(sprint.id) as {source_issue_id:number;source_issue_key:string;snapshot:string}[];
  return {...sprint, evidence:evidence.map(e=>({sourceIssueId:e.source_issue_id,sourceIssueKey:e.source_issue_key,snapshot:JSON.parse(e.snapshot)})), legacy: row.legacy_data ? JSON.parse(row.legacy_data) : null,
    items: items.map(i => ({id: i.id, sprintId: i.sprint_id, issueId: i.issue_id, sourceIssueKey: i.source_issue_key, origin: i.origin, snapshot: JSON.parse(i.snapshot)})),
    events: events.map(e => ({original: JSON.parse(e.original), association: e.association})),
  };
}

export interface CurrentSprintOptions {
  clock?: SprintClock;
  // 未指定は全Workspace。空配列は閲覧できるWorkspaceなし。
  workspaceIds?: readonly number[];
  archived?: boolean;
}

export function resolveCurrentSprints(db: Database, options: CurrentSprintOptions = {}): CurrentSprintResolution {
  const read = (): CurrentSprintResolution => {
    const instant = (options.clock?.now ?? new Date()).toISOString();
    const workspaceSql = options.workspaceIds === undefined ? "" : options.workspaceIds.length
      ? ` AND s.workspace_id IN (${options.workspaceIds.map(() => "?").join(",")})` : " AND 0";
    const rows = db.query(`SELECT s.* FROM sprints s JOIN sprint_plans p ON ${AGREED_PLAN}
      JOIN workspaces w ON w.id=s.workspace_id WHERE ${CURRENT_SPRINT}${workspaceSql}
      ORDER BY s.number`).all(instant, instant, ...(options.workspaceIds ?? [])) as SprintRow[];
    const sprints = rows.map(toSprint);
    // Issueの参照集合は通常読取と同じ変換を使い、取得失敗を空結果へ変換しない。
    const scope=sprintIssueScope(db,'current',{now:options.clock?.now ?? new Date(instant)});
    const issueWorkspaceSql=workspaceSql.replaceAll('s.workspace_id','i.workspace_id');
    const issues=selectIssues(db, `WHERE i.archived_at IS ${options.archived ? "NOT " : ""}NULL
      AND ${scope.where}${issueWorkspaceSql} ORDER BY w.key,i.number`, [...scope.params,...(options.workspaceIds ?? [])]);
    return {sprints, issues};
  };
  return db.inTransaction ? read() : db.transaction(read)();
}

// iは呼び出し元のissues別名。採択は採用中の人が合意したplanだけで判定する。
// 候補や未採用の合意済み案は所属として数えない。
export function sprintIssueScope(db: Database, ref: string, clock: SprintClock = {}): {where: string; params: (string | number)[]} {
  const value=ref.trim();
  const membership = SPRINT_MEMBERSHIP;
  if (value.toLowerCase()==='none') return {where:`NOT EXISTS (${membership})`, params:[]};
  if (value.toLowerCase()==='current') {
    const instant=(clock.now ?? new Date()).toISOString();
    return {where:`EXISTS (SELECT 1 FROM sprint_items si JOIN sprints s ON s.id=si.sprint_id
      JOIN sprint_plans p ON ${AGREED_PLAN} JOIN sprint_plan_items pi ON pi.plan_id=p.id AND pi.item_id=si.id
      WHERE si.issue_id=i.id AND i.workspace_id=s.workspace_id AND ${CURRENT_SPRINT})`,params:[instant,instant]};
  }
  const sprint=resolveSprint(db,value);
  return {where:`EXISTS (${membership} AND s.id=?)`,params:[sprint.id]};
}


// 発行は後続の作成transactionで行う。この読取だけでは番号を消費しない。
export function nextSprintNumber(db: Database): number {
  const row=db.query('SELECT next_number FROM sprint_number_sequence WHERE id=1').get() as {next_number:number}|null;
  if (!row) throw new NodError('SPRINT_SEQUENCE_MISSING','Sprintの採番情報がありません');
  return row.next_number;
}
