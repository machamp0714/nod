import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openDb, SCHEMA_VERSION, schemaVersion } from "../src/db";
import { listWorkspaces } from "../src/ops/workspaces";
import { MIGRATIONS } from "../src/schema";
import { tempDbPath } from "./helpers";

function legacyDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys=ON");
  for (const step of MIGRATIONS[0]!) {
    if (typeof step !== "string") throw new Error("v1はSQLのみ");
    db.exec(step);
  }
  db.exec("PRAGMA user_version=1");
  // idと作成日時の順を意図的にずらす。同時刻はid順に確定する。
  for (const [id, key, time] of [[1, "API", "2026-09-02"], [2, "WEB", "2026-09-01"], [3, "NOD", "2026-09-01"], [4, "BLOG", "2026-09-03"]] as const) {
    db.query("INSERT INTO workspaces (id,key,name,path,next_number,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, key, key, `/repos/${key}`, 10 + id, time);
  }
  db.exec("INSERT INTO issues (id,workspace_id,number,title,status,created_by,created_at,updated_at) VALUES (1,1,1,'課題','todo','codex','',''),(2,2,1,'依存','todo','codex','','')");
  db.exec("INSERT INTO issue_labels VALUES (1,'bug')");
  db.exec("INSERT INTO relations VALUES (1,2,'blocks','')");
  db.exec("INSERT INTO events (issue_id,actor,type,created_at) VALUES (1,'codex','created','')");
  return db;
}

function snapshot(db: Database) {
  return Object.fromEntries(["issues", "issue_labels", "relations", "events"].map((table) => [table, db.query(`SELECT * FROM ${table}`).all()]));
}

test("v1を作成日時/id順で一度だけ移行し、子データ・連番・FKを保持する", () => {
  const path = tempDbPath();
  const old = legacyDb(path);
  const children = snapshot(old);
  const workspaces = old.query("SELECT * FROM workspaces ORDER BY id").all();
  old.close();
  const db = openDb(path);
  expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(listWorkspaces(db).map((w) => [w.key, w.color])).toEqual([
    ["API", "#C36B04"], ["BLOG", "#DB2777"], ["NOD", "#0D9768"], ["WEB", "#7C5CFF"],
  ]);
  expect(db.query("SELECT id,key,name,path,next_number,created_at FROM workspaces ORDER BY id").all()).toEqual(workspaces);
  expect(snapshot(db)).toEqual(children);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  const colors = listWorkspaces(db);
  db.close();
  const reopened = openDb(path);
  expect(listWorkspaces(reopened)).toEqual(colors);
  reopened.close();
});

test("backfill途中の失敗はALTERと色と版をrollbackし、修復後に再移行できる", () => {
  const path = tempDbPath();
  const old = legacyDb(path);
  const children = snapshot(old);
  const workspaces = old.query("SELECT * FROM workspaces ORDER BY id").all();
  old.exec("CREATE TRIGGER fail_backfill BEFORE UPDATE ON workspaces WHEN NEW.id=3 BEGIN SELECT RAISE(ABORT,'移行失敗を再現'); END");
  old.close();
  expect(() => openDb(path)).toThrow("移行失敗を再現");
  const raw = new Database(path);
  expect(schemaVersion(raw)).toBe(1);
  expect(raw.query("SELECT * FROM workspaces ORDER BY id").all()).toEqual(workspaces);
  expect(snapshot(raw)).toEqual(children);
  expect(raw.query("PRAGMA table_info(workspaces)").all().some((column: any) => column.name === "color")).toBe(false);
  raw.exec("DROP TRIGGER fail_backfill");
  raw.close();
  const fixed = openDb(path);
  expect(schemaVersion(fixed)).toBe(SCHEMA_VERSION);
  expect(new Set(listWorkspaces(fixed).map((w) => w.color)).size).toBe(4);
  fixed.close();
});

test("既存25件超も小さなパレット上限で拒否せず追加色へ移行する", () => {
  const path = tempDbPath();
  const old = legacyDb(path);
  for (let i = 5; i <= 30; i++) {
    old.query("INSERT INTO workspaces (key,name,path,created_at) VALUES (?,?,?,?)").run(`W${i}`, `w${i}`, `/w${i}`, "2026-09-04");
  }
  old.close();
  const db = openDb(path);
  expect(listWorkspaces(db)).toHaveLength(30);
  expect(new Set(listWorkspaces(db).map((w) => w.color)).size).toBe(30);
  db.close();
});
