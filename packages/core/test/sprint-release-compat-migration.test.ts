import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openDb, schemaVersion, SCHEMA_VERSION } from "../src/db";
import { addInReview } from "../src/migrations/add-in-review";
import { createIssue, getIssue, updateIssue } from "../src/ops/issues";
import { getSprint, listSprints, resolveLegacyCycle } from "../src/ops/sprints";
import { initWorkspace } from "../src/ops/workspaces";
import { MIGRATIONS } from "../src/schema";
import { legacySprintFixture } from "./fixtures/sprint";
import { tempDbPath } from "./helpers";

test("本番系の版43をレビュー状態と関連原本と旧所属を保って移行し、再読込でも履歴を増やさない", () => {
  const path = tempDbPath();
  legacySprintFixture(path);
  const old = new Database(path);
  addInReview(old);
  old.exec(`PRAGMA user_version=43;
    UPDATE issues SET status='in_review',assignee='codex',pr_url='https://github.com/example/nod/pull/1' WHERE id=1;
    INSERT INTO workspace_status_names VALUES(1,'in_review','レビュー中');
    INSERT INTO workspace_transition_rules VALUES(1,'in_review','in_progress');
    INSERT INTO questions(id,issue_id,question,asked_by,asked_at) VALUES(1,1,'移行前の質問','me','2026-01-01');
    INSERT INTO comments(id,issue_id,author,body,created_at) VALUES(1,1,'me','移行前のコメント','2026-01-01');
    INSERT INTO documents(id,path,title,kind,created_at) VALUES(1,'/fixture/spec.md','移行前の仕様','spec','2026-01-01');
    INSERT INTO document_links(document_id,issue_id) VALUES(1,1);
    INSERT INTO subscriptions VALUES(1,'me','2026-01-01');
    INSERT INTO relations VALUES(1,2,'related','2026-01-01');
    INSERT INTO plan_tasks(issue_id,position,title,status) VALUES(1,1,'移行前の作業','doing');`);
  const tables = ["issues", "questions", "comments", "documents", "document_links", "subscriptions", "relations", "plan_tasks", "events", "workspace_status_names", "workspace_transition_rules"];
  const before = tables.map(table => old.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
  old.close();

  let db = openDb(path);
  expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(tables.map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before.map((rows, index) =>
    tables[index] === "issues" ? rows.map(row => { const { cycle_id, ...kept } = row as Record<string, unknown>; return kept; }) : rows));
  expect(getIssue(db, "AAA-1")).toMatchObject({ status: "in_review", questions: [{ question: "移行前の質問" }], documents: [{ title: "移行前の仕様" }] });
  expect(listSprints(db).map(sprint => [sprint.number, sprint.phase])).toEqual([[1, "imported"], [2, "imported"], [3, "imported"], [4, "imported"]]);
  const history = getSprint(db, "1");
  expect(history.items.map(item => [item.sourceIssueKey, item.snapshot.issue.status])).toEqual([["AAA-1", "in_review"], ["BBB-1", "todo"]]);
  expect(history.events.map(event => event.original.id)).toEqual([1, 2, 3]);
  expect(resolveLegacyCycle(db, 1)).toEqual({ kind: "imported", sprintId: history.id });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  db.close();

  db = openDb(path);
  expect(getSprint(db, "1")).toEqual(history);
  expect(listSprints(db)).toHaveLength(4);
  expect(getIssue(db, "AAA-1").status).toBe("in_review");
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  db.close();
});

test.each([43, 44, 45, 46, 47, 48, 49])("Sprint導入済みの版%iは履歴と参照を保ち、レビュー状態を追加して再読込できる", (version) => {
  const path = tempDbPath();
  legacySprintFixture(path);
  const old = new Database(path);
  for (const migration of MIGRATIONS.slice(42, version)) for (const step of migration) {
    if (typeof step === "string") old.exec(step); else step(old);
  }
  old.exec(`PRAGMA user_version=${version};
    INSERT INTO questions(issue_id,question,asked_by,asked_at) VALUES(1,'Sprint導入済みの質問','me','2026-01-01');`);
  const tables = ["sprint_migration_source", "sprint_items", "sprint_legacy_issue_evidence", "sprint_legacy_refs", "sprint_legacy_events", "sprint_legacy_event_refs", "sprint_plans", "sprint_plan_items", "questions"];
  const before = tables.map(table => old.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const identities = old.query("SELECT id,number,legacy_cycle_id,legacy_data FROM sprints ORDER BY number").all();
  old.close();

  let db = openDb(path);
  expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(db.query("SELECT id,number,legacy_cycle_id,legacy_data FROM sprints ORDER BY number").all()).toEqual(identities);
  expect(tables.map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
  const history = getSprint(db, "1");
  updateIssue({ db, actor: "me" }, "AAA-1", { status: "in_review" });
  expect(getIssue(db, "AAA-1")).toMatchObject({ status: "in_review", questions: [{ question: "Sprint導入済みの質問" }] });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  db.close();

  db = openDb(path);
  expect(getSprint(db, "1")).toEqual(history);
  expect(getIssue(db, "AAA-1").status).toBe("in_review");
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  db.close();
});

test("新規DBでもSprintとレビュー状態を初期化し、通常のIssueを再読込できる", () => {
  const path = tempDbPath();
  let db = openDb(path);
  const workspace = initWorkspace(db, { path: "/tmp/release-compat", key: "NEW" }).workspace;
  const issue = createIssue({ db, actor: "me" }, { workspaceId: workspace.id, title: "新規レビュー" });
  updateIssue({ db, actor: "me" }, issue.id, { status: "in_review" });
  expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(listSprints(db)).toEqual([]);
  db.close();

  db = openDb(path);
  expect(getIssue(db, issue.id).status).toBe("in_review");
  expect(listSprints(db)).toEqual([]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  db.close();
});
