import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openDb, SCHEMA_VERSION, schemaVersion } from "../src/db";
import { deleteIssue } from "../src/ops/issue-deletions";
import { listTriageProposals } from "../src/ops/triage-proposals";
import { MIGRATIONS } from "../src/schema";
import { tempDbPath } from "./helpers";

// #145: 重複先の Issue を永久削除しても提案を消さない（duplicate_of_id を ON DELETE SET NULL にする表の再作成）
test("既存の提案を保ったまま duplicate_of_id を ON DELETE SET NULL に移行し、重複先を消しても提案が残る", () => {
  const before = MIGRATIONS.findIndex((steps) => steps.some((s) => typeof s === "string" && s.includes("CREATE TABLE triage_proposals_new")));
  expect(before).toBeGreaterThan(0);
  const path = tempDbPath();
  const old = new Database(path, { create: true });
  old.exec("PRAGMA foreign_keys=ON");
  for (const [v, steps] of MIGRATIONS.slice(0, before).entries()) {
    for (const step of steps) {
      if (typeof step === "string") old.exec(step);
      else step(old);
    }
    old.exec(`PRAGMA user_version=${v + 1}`);
  }
  old.exec("INSERT INTO workspaces (id,key,name,path,next_number,created_at,color) VALUES (1,'API','api','/tmp/api',4,'2026-01-01','#3B82F6')");
  old.exec("INSERT INTO projects (id,name,created_by,created_at,updated_at) VALUES (7,'基盤','me','2026-01-01','2026-01-01')");
  old.exec(
    `INSERT INTO issues (id,workspace_id,number,title,status,created_by,created_at,updated_at,archived_at) VALUES
      (1,1,1,'重複先','todo','me','2026-01-01','2026-01-01','2026-01-02'),
      (2,1,2,'重複かも','triage','claude-code','2026-01-01','2026-01-01',NULL),
      (3,1,3,'受け入れかも','triage','claude-code','2026-01-01','2026-01-01',NULL)`,
  );
  old.exec(
    `INSERT INTO triage_proposals (issue_id,actor,decision,duplicate_of_id,labels,assignee,priority,project_id,reason,created_at,updated_at) VALUES
      (2,'claude-code','duplicate',1,'[]',NULL,NULL,NULL,'同じ内容','2026-01-03','2026-01-03'),
      (2,'codex','accept',NULL,'["bug","api"]','alice',1,7,'直すべき','2026-01-04','2026-01-05'),
      (3,'claude-code','accept',NULL,'["docs"]',NULL,3,NULL,NULL,'2026-01-06','2026-01-06')`,
  );
  const rows = () => old.query("SELECT * FROM triage_proposals ORDER BY issue_id, actor").all();
  const saved = rows();
  expect(saved).toHaveLength(3);
  old.close();

  const db = openDb(path);
  expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(db.query("SELECT * FROM triage_proposals ORDER BY issue_id, actor").all()).toEqual(saved);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  const fk = db.query("PRAGMA foreign_key_list(triage_proposals)").all() as { from: string; on_delete: string }[];
  expect(Object.fromEntries(fk.map((f) => [f.from, f.on_delete]))).toEqual({
    issue_id: "CASCADE",
    duplicate_of_id: "SET NULL",
    project_id: "SET NULL",
  });

  // 重複先を永久削除しても、提案（ラベル・担当・優先度・Project・理由）は残り、重複先だけが外れる
  deleteIssue({ db, actor: "me" }, "API-1");
  expect(listTriageProposals(db, "API-2")).toMatchObject([
    { actor: "codex", decision: "accept", duplicateOf: null, labels: ["bug", "api"], assignee: "alice", priority: 1, project: { id: 7, name: "基盤" }, reason: "直すべき" },
    { actor: "claude-code", decision: "duplicate", duplicateOf: null, reason: "同じ内容" },
  ]);
  expect(listTriageProposals(db, "API-3")).toMatchObject([{ decision: "accept", labels: ["docs"], priority: 3 }]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});
