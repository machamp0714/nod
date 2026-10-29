import type { Database } from "bun:sqlite";

export function prepareSprintExecutionStorage(db: Database): void {
  db.exec(`
    CREATE TABLE sprint_sessions (
      id TEXT PRIMARY KEY, sprint_id TEXT NOT NULL UNIQUE REFERENCES sprints(id) ON DELETE RESTRICT,
      generation INTEGER NOT NULL CHECK(generation>0), payload TEXT NOT NULL CHECK(json_valid(payload))
    );
    CREATE TABLE sprint_execution_versions (
      sprint_id TEXT PRIMARY KEY REFERENCES sprints(id) ON DELETE RESTRICT, version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sprint_attempts (
      id TEXT PRIMARY KEY, sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE RESTRICT,
      item_id TEXT NOT NULL REFERENCES sprint_items(id) ON DELETE RESTRICT,
      source_issue_key TEXT NOT NULL, parent_attempt_id TEXT REFERENCES sprint_attempts(id) ON DELETE RESTRICT,
      occupied INTEGER NOT NULL CHECK(occupied IN(0,1)), payload TEXT NOT NULL CHECK(json_valid(payload))
    );
    CREATE UNIQUE INDEX sprint_unresolved_primary ON sprint_attempts(source_issue_key)
      WHERE parent_attempt_id IS NULL AND occupied=1;
    CREATE TABLE sprint_operations (
      id TEXT PRIMARY KEY, sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE RESTRICT,
      attempt_id TEXT NOT NULL REFERENCES sprint_attempts(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK(kind IN('task_create','worker_start')), request_key TEXT NOT NULL,
      payload TEXT NOT NULL CHECK(json_valid(payload)), UNIQUE(sprint_id,kind,request_key)
    );
    CREATE TABLE sprint_execution_snapshots (
      id TEXT PRIMARY KEY, sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE RESTRICT,
      payload TEXT NOT NULL CHECK(json_valid(payload))
    );
    CREATE TABLE sprint_execution_quarantine (
      id TEXT PRIMARY KEY, sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE RESTRICT,
      payload TEXT NOT NULL CHECK(json_valid(payload))
    );
  `);
}
