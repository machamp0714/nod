import type { Database } from "bun:sqlite";

export function prepareSprintStartObservation(db: Database): void {
  db.exec(`CREATE TABLE sprint_operations_next (
    id TEXT PRIMARY KEY, sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE RESTRICT,
    attempt_id TEXT NOT NULL REFERENCES sprint_attempts(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK(kind IN('task_create','worker_start','worker_begin')), request_key TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)), UNIQUE(sprint_id,kind,request_key)
  );
  INSERT INTO sprint_operations_next SELECT * FROM sprint_operations;
  DROP TABLE sprint_operations;
  ALTER TABLE sprint_operations_next RENAME TO sprint_operations;`);
}
