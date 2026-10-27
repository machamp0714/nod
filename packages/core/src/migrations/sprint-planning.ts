import type { Database } from "bun:sqlite";

// 旧CHECKはWorkspace削除時のSET NULLも禁止していた。写しを残して参照だけ外せる表へ移す。
// 呼出し元がforeign_keysを一時停止し、移行transactionの最後に整合性を検査する。
export function prepareSprintPlanning(db: Database): void {
  db.exec(`CREATE TABLE sprints_next (
    id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE CHECK(number>0),
    workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
    name TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('imported','draft','ready','active','ended','canceled')),
    start_date TEXT NOT NULL, end_date TEXT NOT NULL, timezone TEXT,
    starts_at TEXT, ends_at TEXT, adopted_plan_id TEXT,
    goal TEXT, definition_of_done TEXT, outcome TEXT,
    legacy_cycle_id INTEGER UNIQUE, legacy_data TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0, working_days TEXT NOT NULL DEFAULT '[1,2,3,4,5]', workspace_snapshot TEXT,
    activated_at TEXT, canceled_at TEXT, cancel_reason TEXT,
    replans_sprint_id TEXT REFERENCES sprints(id) ON DELETE RESTRICT,
    CHECK(phase='imported' OR (timezone IS NOT NULL AND (workspace_id IS NOT NULL OR workspace_snapshot IS NOT NULL))),
    CHECK(start_date<=end_date)
  );
  INSERT INTO sprints_next(id,number,workspace_id,name,phase,start_date,end_date,timezone,starts_at,ends_at,adopted_plan_id,
    goal,definition_of_done,outcome,legacy_cycle_id,legacy_data,created_at,updated_at)
    SELECT id,number,workspace_id,name,phase,start_date,end_date,timezone,starts_at,ends_at,adopted_plan_id,
      goal,definition_of_done,outcome,legacy_cycle_id,legacy_data,created_at,updated_at FROM sprints;`);
  const rows = db.query("SELECT id,key,name FROM workspaces").all() as {id:number;key:string;name:string}[];
  for (const ws of rows) db.query("UPDATE sprints_next SET workspace_snapshot=? WHERE workspace_id=?").run(JSON.stringify(ws),ws.id);
  db.exec(`DROP TABLE sprints;
    ALTER TABLE sprints_next RENAME TO sprints;
    CREATE UNIQUE INDEX sprints_active_workspace ON sprints(workspace_id) WHERE phase='active';
    CREATE TRIGGER sprints_number_floor BEFORE INSERT ON sprints
      WHEN NEW.number < (SELECT next_number FROM sprint_number_sequence WHERE id=1)
      BEGIN SELECT RAISE(ABORT,'Sprint番号は再利用できません'); END;
    CREATE TRIGGER sprints_number_advance AFTER INSERT ON sprints
      BEGIN UPDATE sprint_number_sequence SET next_number=MAX(next_number,NEW.number+1) WHERE id=1; END;
    CREATE TRIGGER sprints_number_immutable BEFORE UPDATE OF number ON sprints WHEN NEW.number<>OLD.number
      BEGIN SELECT RAISE(ABORT,'Sprint番号は変更できません'); END;`);
}
