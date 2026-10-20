import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openDb } from "../src/db";
import { MIGRATIONS } from "../src/schema";
import { getIssue } from "../src/ops/issues";
import { tempDbPath } from "./helpers";

test("旧レビュー待ちを完了へ移行し、差し戻し・コメント・履歴・関連データを保持して再起動できる", () => {
  const path = tempDbPath();
  const old = new Database(path);
  old.exec("PRAGMA foreign_keys=ON");
  // 撤去前の版を再現し、アプリと同じ reopen 境界で移行を検証する。
  for (const migration of MIGRATIONS.slice(0, 39)) for (const step of migration) {
    if (typeof step === "string") old.exec(step); else step(old);
  }
  old.exec("PRAGMA user_version=39");
  old.exec(`INSERT INTO workspaces (id,key,name,path,created_at,color) VALUES(1,'NOD','nod','/nod','2026-01-01','#123456');
    INSERT INTO issues (id,workspace_id,number,title,status,created_by,created_at,updated_at,started_at)
      VALUES(1,1,1,'完了報告済み','in_review','codex','2026-01-01','2026-01-03','2026-01-02'),
            (2,1,2,'差し戻し済み','in_progress','codex','2026-01-01','2026-01-04','2026-01-02');
    INSERT INTO comments (id,issue_id,author,body,created_at) VALUES(1,1,'codex','作業が完了しました','2026-01-03');
    INSERT INTO events (issue_id,actor,type,data,created_at) VALUES(1,'codex','status_changed','{"from":"in_progress","to":"in_review","report_comment_id":1}','2026-01-03'),
      (2,'me','review_rejected','{"reason":"追記してください"}','2026-01-04');
    INSERT INTO issue_labels VALUES(1,'bug');
    INSERT INTO comments (id,issue_id,author,body,created_at) VALUES(2,2,'me','追記の依頼','2026-01-04');
    INSERT INTO agent_instructions (issue_id,comment_id,kind,created_by,created_at) VALUES(2,2,'review_fix','me','2026-01-04');
    INSERT INTO documents (id,path,title,kind,created_at) VALUES(1,'/仕様.md','仕様','spec','2026-01-01');
    INSERT INTO document_links (document_id,issue_id) VALUES(1,1);
    INSERT INTO issue_attachments (issue_id,kind,url,created_by,created_at) VALUES(1,'link','https://example.com/result','codex','2026-01-03');
    INSERT INTO plan_tasks (issue_id,position,title,status) VALUES(1,1,'実装','done');
    INSERT INTO relations VALUES(1,2,'related','2026-01-02');
    INSERT INTO workspace_transition_rules VALUES(1,'todo','in_review');
    INSERT INTO workspace_transition_rules VALUES(1,'todo','canceled');
    INSERT INTO workspace_transition_presets VALUES(1,'review_before_done');
    INSERT INTO workspace_status_names VALUES(1,'in_review','確認待ち');
    INSERT INTO views (name,filter) VALUES('レビュー待ち','{"status":["in_review","todo"]}');`);
  const retainedTables = ["comments", "agent_instructions", "documents", "document_links", "issue_attachments", "plan_tasks"];
  const before = retainedTables.map((table) => old.query(`SELECT * FROM ${table}`).all());
  old.close();
  const db = openDb(path);
  expect(retainedTables.map((table) => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
  expect(getIssue(db, "NOD-1")).toMatchObject({status:"done",closedAt:"2026-01-03",labels:["bug"]});
  expect(getIssue(db, "NOD-1").activity.some(a => a.kind === "comment" && a.body === "作業が完了しました")).toBe(true);
  expect(getIssue(db, "NOD-2").status).toBe("in_progress");
  expect(db.query("SELECT * FROM relations").all()).toHaveLength(1);
  expect(db.query("SELECT * FROM events").all()).toHaveLength(3);
  expect(db.query("SELECT from_status,to_status FROM workspace_transition_rules").all()).toEqual([{from_status:"todo",to_status:"canceled"}]);
  expect(db.query("SELECT * FROM workspace_transition_presets").all()).toEqual([]);
  expect(db.query("SELECT * FROM workspace_status_names").all()).toEqual([]);
  expect(JSON.parse((db.query("SELECT filter FROM views").get() as {filter:string}).filter)).toEqual({status:["done","todo"]});
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() => db.exec("UPDATE issues SET status='in_review' WHERE id=1")).toThrow();
  db.close();
  const reopened=openDb(path);
  expect(getIssue(reopened,"NOD-1").closedAt).toBe("2026-01-03");
  reopened.close();
});
