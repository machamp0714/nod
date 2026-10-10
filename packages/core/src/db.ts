import { Database } from "bun:sqlite";
import { existsSync, linkSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
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
    // 版が上がる migration の前に、旧版の整合したコピーを取る。失敗したら DB を変えずに止める
    backupBeforeMigrate(db, path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (e) {
    db.close();
    throw toNodError(e);
  }
  return db;
}

const BACKUP_GENERATIONS = 5;
const BACKUP_NAME = /^nod-\d{8}T\d{9}Z-\d{4}-v\d+\.db$/;

// 版が上がる migration があるとき（新規 DB の版 0 と、新しすぎる DB は除く）、DB の隣の backups/ に VACUUM INTO で
// 整合したコピーを取る（WAL のコミット済みデータを含む）。一時名で作って完了後に世代へ加え、最新 5 世代だけを残す。
// 名前は nod-<UTC 時刻(ミリ秒)>-<同一時刻の連番>-v<元の版>.db で、辞書順が時系列になる
function backupBeforeMigrate(db: Database, path: string): void {
  if (path === ":memory:" || path === "") return;
  const from = schemaVersion(db);
  if (from === 0 || from >= SCHEMA_VERSION) return;
  const dir = join(dirname(path), "backups");
  const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    mkdirSync(dir, { recursive: true });
    db.query("VACUUM INTO ?").run(tmp);
    const stamp = new Date().toISOString().replace(/[-:.]/g, "");
    for (let seq = 0; ; seq++) {
      const dest = join(dir, `nod-${stamp}-${String(seq).padStart(4, "0")}-v${from}.db`);
      try {
        linkSync(tmp, dest); // 既にあれば失敗する（上書きしない）
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST") throw e;
      }
    }
    unlinkSync(tmp);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw new NodError(
      "DB_BACKUP_FAILED",
      `migration 前のバックアップを取れなかったため、DB を変更せずに中止しました（${dir}）: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // 古い世代の削除は付随処理。失敗しても migration は止めない
  try {
    const names = readdirSync(dir).filter((n) => BACKUP_NAME.test(n)).sort();
    for (const n of names.slice(0, Math.max(0, names.length - BACKUP_GENERATIONS))) unlinkSync(join(dir, n));
  } catch {}
}

// 読むだけのときに使う。DB がなければ作らず null を返し、migration もしない（古い DB では読みたい表や列がなく、クエリが失敗しうる）。
// 書き込みを待たないよう busy_timeout は短くする
export function openDbReadonly(path: string = defaultDbPath()): Database | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 500");
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
