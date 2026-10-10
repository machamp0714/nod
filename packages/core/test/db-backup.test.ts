import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb, SCHEMA_VERSION, schemaVersion } from "../src/db";
import { MIGRATIONS } from "../src/schema";
import { codeOf, tempDbPath } from "./helpers";

// 版 1 の DB を WAL モードで作る。接続は閉じずに返す（閉じると WAL がメインファイルに取り込まれ、WAL 上のデータを確かめられない）
function legacyDb(path: string, marker: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_autocheckpoint = 0");
  db.exec("PRAGMA foreign_keys = ON");
  for (const step of MIGRATIONS[0]!) {
    if (typeof step !== "string") throw new Error("v1 は SQL のみ");
    db.exec(step);
  }
  db.exec("PRAGMA user_version = 1");
  db.query("INSERT INTO workspaces (id,key,name,path,next_number,created_at) VALUES (1,?,?,?,1,'')").run(marker, marker, `/repos/${marker}`);
  return db;
}

function backupsOf(path: string): string[] {
  const dir = join(dirname(path), "backups");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function readBackup(path: string, name: string) {
  const db = new Database(join(dirname(path), "backups", name), { readonly: true });
  const version = schemaVersion(db);
  const keys = (db.query("SELECT key FROM workspaces ORDER BY id").all() as { key: string }[]).map((r) => r.key);
  db.close();
  return { version, keys };
}

test("版が上がる前に、WAL のコミット済みデータを含む旧版のコピーを backups/ に 1 つだけ取る", () => {
  const path = tempDbPath();
  const old = legacyDb(path, "OLD");
  const db = openDb(path);
  old.close();
  expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  const names = backupsOf(path);
  expect(SCHEMA_VERSION).toBeGreaterThan(2); // 複数版を一度に進めても 1 つだけ、を確かめられる
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^nod-.*-v1\.db$/);
  expect(readBackup(path, names[0]!)).toEqual({ version: 1, keys: ["OLD"] });
  // 移行後の DB には旧版のデータが残る
  expect((db.query("SELECT key FROM workspaces").all() as { key: string }[]).map((r) => r.key)).toEqual(["OLD"]);
  db.close();
  expect(readdirSync(join(dirname(path), "backups")).filter((n) => !n.endsWith(".db"))).toEqual([]);
});

test("現行版の DB を開き直してもバックアップは増えない", () => {
  const path = tempDbPath();
  legacyDb(path, "OLD").close();
  openDb(path).close();
  expect(backupsOf(path)).toHaveLength(1);
  openDb(path).close();
  openDb(path).close();
  expect(backupsOf(path)).toHaveLength(1);
});

test("新規 DB（版 0）ではバックアップを取らず、backups/ も作らない", () => {
  const path = tempDbPath();
  openDb(path).close();
  expect(existsSync(join(dirname(path), "backups"))).toBe(false);
});

test(":memory: の DB でも開ける", () => {
  const db = openDb(":memory:");
  expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  db.close();
});

test("最新 5 世代を残して古いものを消す。同じミリ秒でも衝突せず、名前の辞書順が時系列になる", () => {
  const path = tempDbPath();
  const realNow = Date.now;
  Date.now = () => 1_800_000_000_000; // 全て同一ミリ秒
  try {
    for (let i = 0; i < 7; i++) {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
      const old = legacyDb(path, `GEN${i}`);
      openDb(path).close();
      old.close();
    }
  } finally {
    Date.now = realNow;
  }
  const names = backupsOf(path);
  expect(names).toHaveLength(5);
  expect(names.map((n) => readBackup(path, n).keys[0])).toEqual(["GEN2", "GEN3", "GEN4", "GEN5", "GEN6"]);
});

test("バックアップに失敗したら migration せず、DB を変えずに NodError にする", () => {
  const path = tempDbPath();
  legacyDb(path, "OLD").close();
  // backups を同名のファイルにして、作れなくする
  writeFileSync(join(dirname(path), "backups"), "file");
  let err: unknown;
  try {
    openDb(path);
  } catch (e) {
    err = e;
  }
  expect((err as { code?: string }).code).toBe("DB_BACKUP_FAILED");
  const raw = new Database(path, { readonly: true });
  expect(schemaVersion(raw)).toBe(1);
  expect(raw.query("SELECT key FROM workspaces").all()).toEqual([{ key: "OLD" }]);
  raw.close();
});

test("版が新しすぎる場合は従来の SCHEMA_TOO_NEW のままで、バックアップは取らない", () => {
  const path = tempDbPath();
  const db = new Database(path, { create: true });
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  db.close();
  expect(codeOf(() => openDb(path))).toBe("SCHEMA_TOO_NEW");
  expect(existsSync(join(dirname(path), "backups"))).toBe(false);
});
