import type { Database } from "bun:sqlite";

export function prepareSprintNotifications(db: Database): void {
  db.exec(`
    CREATE TABLE sprint_notification_results (
      id TEXT PRIMARY KEY, sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE RESTRICT,
      logical_key TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), UNIQUE(sprint_id,logical_key)
    );
    CREATE TABLE sprint_notification_receptions (
      message_id TEXT NOT NULL, sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE RESTRICT,
      payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(sprint_id,message_id)
    );
    CREATE TABLE sprint_notification_deliveries (
      delivery_id TEXT NOT NULL, sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE RESTRICT,
      payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(sprint_id,delivery_id)
    );
    CREATE TABLE sprint_notification_conflicts (
      sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE RESTRICT, message_id TEXT NOT NULL,
      input_hash TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(sprint_id,message_id,input_hash)
    );
    CREATE TABLE sprint_notification_quarantine (
      sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE RESTRICT, message_id TEXT NOT NULL,
      input_hash TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(sprint_id,message_id,input_hash)
    );
  `);
}
