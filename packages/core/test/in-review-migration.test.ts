import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openDb } from "../src/db";
import { MIGRATIONS } from "../src/schema";
import { getIssue } from "../src/ops/issues";
import { tempDbPath } from "./helpers";

test("版42からの更新はDone・open PR・旧履歴・保存ビュー・関連データを変更しない", () => {
  const path = tempDbPath();
  const old = new Database(path);
  for (const migration of MIGRATIONS.slice(0, 42)) for (const step of migration) {
    if (typeof step === "string") old.exec(step); else step(old);
  }
  old.exec("PRAGMA user_version=42");
  old.exec(`INSERT INTO workspaces (id,key,name,path,created_at,color) VALUES(1,'NOD','nod','/nod','2026-01-01','#123456');
    INSERT INTO issues (id,workspace_id,number,title,status,created_by,created_at,updated_at,started_at,closed_at,pr_url)
      VALUES(1,1,1,'過去の完了','done','codex','2026-01-01','2026-01-03','2026-01-02','2026-01-03','https://github.com/example/nod/pull/1'),
            (2,1,2,'PRありの実装中','in_progress','codex','2026-01-01','2026-01-04','2026-01-02',NULL,'https://github.com/example/nod/pull/2');
    INSERT INTO comments (id,issue_id,author,body,created_at) VALUES(1,1,'codex','作業が完了しました','2026-01-03');
    INSERT INTO events (issue_id,actor,type,data,created_at) VALUES(1,'codex','status_changed','{"from":"in_progress","to":"in_review","report_comment_id":1}','2026-01-03');
    INSERT INTO issue_labels VALUES(1,'bug');
    INSERT INTO documents (id,path,title,kind,created_at) VALUES(1,'/仕様.md','仕様','spec','2026-01-01');
    INSERT INTO document_links (document_id,issue_id) VALUES(1,1);
    INSERT INTO issue_attachments (issue_id,kind,url,created_by,created_at) VALUES(1,'link','https://example.com/result','codex','2026-01-03');
    INSERT INTO plan_tasks (issue_id,position,title,status) VALUES(1,1,'実装','done');
    INSERT INTO relations VALUES(1,2,'related','2026-01-02');
    INSERT INTO workspace_transition_rules VALUES(1,'todo','canceled');
    INSERT INTO workspace_status_names VALUES(1,'done','完了');
    INSERT INTO views (name,filter) VALUES('完了と実装中','{ "status": ["done", "in_progress"] }');`);
  const tables = (old.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  const before = tables.map(table => old.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
  old.close();
  const db = openDb(path);
  expect(tables.map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
  expect(getIssue(db, "NOD-1")).toMatchObject({ status: "done", closedAt: "2026-01-03", startedAt: "2026-01-02", labels: ["bug"] });
  expect(getIssue(db, "NOD-2").status).toBe("in_progress");
  db.exec(`UPDATE issues SET status='in_review' WHERE id=2;
    INSERT INTO workspace_status_names VALUES(1,'in_review','レビュー中');
    INSERT INTO workspace_transition_rules VALUES(1,'in_review','done');
    INSERT INTO workspace_transition_rules VALUES(1,'todo','in_review');`);
  expect(() => db.exec("UPDATE issues SET status='invalid_status' WHERE id=2")).toThrow();
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
  const reopened = openDb(path);
  expect(getIssue(reopened, "NOD-2").status).toBe("in_review");
  expect(reopened.query("SELECT name FROM workspace_status_names WHERE status='in_review'").get()).toEqual({ name: "レビュー中" });
  expect(reopened.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  reopened.close();
});
