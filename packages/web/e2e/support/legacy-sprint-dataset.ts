import { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDb } from "@nod/core";
import { legacySprintFixture } from "../../../core/test/fixtures/sprint";
import type { DatasetContext } from "./dataset";

// schema42を公開openDbで移行してから、制御サーバーの隔離DBへ入れる。
export function loadLegacySprintDataset({ db, dir }: Pick<DatasetContext, "db" | "dir">, prepare?: (legacy: Database) => void, fixture = legacySprintFixture): void {
  const path = join(dir, `sprint-history-${crypto.randomUUID()}.db`);
  fixture(path);
  if (prepare) {
    const legacy = new Database(path);
    try { prepare(legacy); } finally { legacy.close(); }
  }
  openDb(path).close();
  db.run("ATTACH DATABASE ? AS legacy_fixture", [path]);
  db.run("PRAGMA foreign_keys=OFF");
  try {
    const tables = db.query("SELECT name FROM legacy_fixture.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    db.transaction(() => {
      for (const { name } of tables) db.run(`DELETE FROM main."${name}"`);
      // 版44の表再作成でsqlite_masterの順序は変わる。採番sequenceは期間の転送後に復元する。
      const ordered = [...tables.filter(t => t.name !== "sprint_number_sequence"), ...tables.filter(t => t.name === "sprint_number_sequence")];
      for (const { name } of ordered) db.run(`INSERT INTO main."${name}" SELECT * FROM legacy_fixture."${name}"`);
    })();
  } finally {
    db.run("PRAGMA foreign_keys=ON");
    db.run("DETACH DATABASE legacy_fixture");
  }
}
