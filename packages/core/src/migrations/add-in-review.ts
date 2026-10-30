import type { Database } from "bun:sqlite";

// 呼び出し元で外部キーを無効化した transaction 内から実行する。
// 既存データを変えず、状態を保存する3表のCHECKだけを拡張する。
export function addInReview(db: Database): void {
  for (const table of ["issues", "workspace_status_names", "workspace_transition_rules"]) {
    const row = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
    // 本番系の版43では導入済み。既存のCHECKと関連を再作成しない。
    if (row.sql.includes("'in_review'")) continue;
    const auxiliaries = db.query(
      "SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL",
    ).all(table) as { sql: string }[];
    const definition = row.sql
      .replace(/'in_progress'/g, "'in_progress','in_review'")
      .replace(new RegExp(`CREATE TABLE ["\x60]?${table}\\b["\x60]?`, "i"), `CREATE TABLE ${table}_new`);
    db.exec(definition);
    const columns = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map((column) => `"${column.name}"`).join(", ");
    db.exec(`INSERT INTO ${table}_new (${columns}) SELECT ${columns} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
    for (const auxiliary of auxiliaries) db.exec(auxiliary.sql);
  }
}
