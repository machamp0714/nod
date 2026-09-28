import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { NodError, toNodError } from "./errors";
import { MIGRATIONS } from "./schema";

export const SCHEMA_VERSION = MIGRATIONS.length;

export function defaultDbPath(env: Record<string, string | undefined> = process.env): string {
  return env.NOD_DB || join(homedir(), ".local", "share", "nod", "nod.db");
}

export function openDb(path: string = defaultDbPath(), opts: { busyTimeoutMs?: number } = {}): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (e) {
    db.close();
    throw toNodError(e);
  }
  return db;
}

export function schemaVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

export function migrate(db: Database): void {
  const current = schemaVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new NodError(
      "SCHEMA_TOO_NEW",
      `DB のスキーマ（版 ${current}）がこの nod（版 ${SCHEMA_VERSION}）より新しいため開けません。nod を更新してください`,
    );
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.transaction(() => {
      // ほかのプロセスが同時に適用し終えていたら、何もしない
      if (schemaVersion(db) !== v) return;
      for (const step of MIGRATIONS[v] ?? []) {
        if (typeof step === "string") db.exec(step);
        else step(db);
      }
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }).immediate();
  }
}

export function tx<T>(db: Database, fn: () => T): T {
  if (db.inTransaction) return fn();
  try {
    return db.transaction(fn).immediate();
  } catch (e) {
    throw toNodError(e);
  }
}
