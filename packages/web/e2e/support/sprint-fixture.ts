import type { Database } from "bun:sqlite";
import { getSprint, getIssue } from "@nod/core";

// E2E専用。開始・採択・移行fixtureを製品のCLI/APIに公開しない。
export function seedSprintFixture(db: Database, input: { name: string; startDate: string; endDate: string }) {
  const id = crypto.randomUUID();
  const number = (db.query("SELECT COALESCE(MAX(number),0)+1 AS n FROM sprints").get() as { n: number }).n;
  const at = new Date().toISOString();
  db.query(`INSERT INTO sprints(id,number,name,phase,start_date,end_date,legacy_data,created_at,updated_at)
    VALUES(?,?,?,'imported',?,?,?,?,?)`).run(id, number, input.name, input.startDate, input.endDate, JSON.stringify({ schemaVersion: 1, cycle: {}, cadence: null, capturedAt: at, statusBasis: "migration_snapshot" }), at, at);
  return getSprint(db, id);
}

export function associateSprintFixture(db: Database, sprintId: string, issueRef: string) {
  const issue = getIssue(db, issueRef);
  const raw = db.query("SELECT * FROM issues WHERE workspace_id=(SELECT id FROM workspaces WHERE key=?) AND number=?").get(issue.workspace, issue.number) as Record<string, unknown> & { id: number; workspace_id: number };
  const workspace = db.query("SELECT id,key,name FROM workspaces WHERE id=?").get(raw.workspace_id);
  const snapshot = JSON.stringify({ schemaVersion: 1, capturedAt: new Date().toISOString(), statusBasis: "migration_snapshot", workspace, issue: raw, labels: issue.labels, project: issue.project });
  db.query("INSERT OR REPLACE INTO sprint_items(id,sprint_id,issue_id,source_issue_key,snapshot,origin) VALUES(?,?,?,?,?,'imported')").run(crypto.randomUUID(), sprintId, raw.id, issue.id, snapshot);
}

export function removeSprintFixture(db: Database, sprintId: string) {
  db.query("DELETE FROM sprint_items WHERE sprint_id=?").run(sprintId);
  db.query("DELETE FROM sprints WHERE id=?").run(sprintId);
}
