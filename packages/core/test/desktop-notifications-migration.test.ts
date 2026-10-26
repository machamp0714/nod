import { Database } from "bun:sqlite";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb, schemaVersion, SCHEMA_VERSION } from "../src/db";
import { getDesktopNotificationSettings } from "../src/ops/desktop-notifications";
import { getIssue } from "../src/ops/issues";
import { listNotifications } from "../src/ops/notifications";
import { MIGRATIONS } from "../src/schema";
import { tempDbPath } from "./helpers";

afterEach(() => setSystemTime());

test("本番の版40から通知を導入し、既存データと版40のバックアップを保ちレビュー状態を復活させない", () => {
  setSystemTime(new Date("2026-10-20T03:00:00Z"));
  const path = tempDbPath();
  const old = new Database(path);
  old.exec("PRAGMA journal_mode=WAL");
  old.exec("PRAGMA wal_autocheckpoint=0");
  // 本番 main の版40を再現する。通知の版41・42を含めない。
  for (const migration of MIGRATIONS.slice(0, 40)) for (const step of migration) {
    if (typeof step === "string") old.exec(step); else step(old);
  }
  old.exec(`PRAGMA user_version=40;
    INSERT INTO workspaces (id,key,name,path,created_at,color) VALUES(1,'NOD','nod','/nod','2026-01-01','#123456');
    INSERT INTO issues (id,workspace_id,number,title,status,due_date,created_by,created_at,updated_at,closed_at)
      VALUES(1,1,1,'完了済み','done','2026-10-19','codex','2026-01-01','2026-10-19','2026-10-19'),
            (2,1,2,'古い期日','todo','2026-10-19','me','2026-01-01','2026-10-19',NULL),
            (3,1,3,'将来の期日','todo','2026-10-21','me','2026-01-01','2026-10-19',NULL);
    INSERT INTO comments (id,issue_id,author,body,created_at) VALUES(1,1,'codex','完了報告','2026-10-19');
    INSERT INTO notifications (id,recipient,issue_id,kind,event_type,actor,data,created_at)
      VALUES(1,'me',2,'reminder','reminder','me','{"note":"既存の通知"}','2026-10-19T03:00:00.000Z');`);
  const retainedTables = (old.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  const before = retainedTables.map(table => old.query(`SELECT * FROM ${table}`).all());

  // WAL接続を残し、移行直前までのデータもバックアップへ含める。
  const db = openDb(path);
  old.close();
  expect(getDesktopNotificationSettings(db)).toEqual({ enabled: false, lastEnabledAt: null });
  expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  const preserved=retainedTables.filter(table=>table!=="cycles" && table!=="cycle_cadence");
  expect(preserved.map(table=>db.query(`SELECT * FROM ${table}`).all())).toEqual(preserved.map(table=>{
    const rows=before[retainedTables.indexOf(table)]!;
    return table==="issues" ? rows.map(row=>{const {cycle_id,...kept}=row as Record<string,unknown>;return kept;}) : rows;
  }));
  expect(getIssue(db, "NOD-1")).toMatchObject({ status: "done", closedAt: "2026-10-19" });
  expect(listNotifications(db)).toMatchObject([{ kind: "reminder", data: { note: "既存の通知" } }]);
  expect(() => db.exec("UPDATE issues SET status='in_review' WHERE id=1")).toThrow();
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

  const backups = readdirSync(join(dirname(path), "backups"));
  expect(backups).toHaveLength(1);
  expect(backups[0]).toMatch(/-v40\.db$/);
  const backup = new Database(join(dirname(path), "backups", backups[0]!), { readonly: true });
  expect(schemaVersion(backup)).toBe(40);
  expect(retainedTables.map(table => backup.query(`SELECT * FROM ${table}`).all())).toEqual(before);
  backup.close();
  db.close();

  const reopened = openDb(path);
  expect(getDesktopNotificationSettings(reopened)).toEqual({ enabled: false, lastEnabledAt: null });
  expect(readdirSync(join(dirname(path), "backups"))).toEqual(backups);
  setSystemTime(new Date("2026-10-21T23:00:00Z"));
  expect(listNotifications(reopened).filter(item => item.kind === "due_date")).toMatchObject([
    { issueId: "NOD-3", data: { dueDate: "2026-10-21" } },
  ]);
  reopened.close();
});
