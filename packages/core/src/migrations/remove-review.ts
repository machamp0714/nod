import type { Database } from "bun:sqlite";

// 呼び出し元で外部キーを無効化した transaction 内から実行する。
// CHECK を持つ表を再作成し、子テーブルと履歴はそのまま保持する。
function removeReviewStatusConstraint(db: Database, table: string): void {
  const row = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
  const auxiliaries = db.query(
    "SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL",
  ).all(table) as { sql: string }[];
  const definition = row.sql
    .replace(/'in_review'\s*,\s*/g, "")
    .replace(new RegExp(`CREATE TABLE ${table}\\b`, "i"), `CREATE TABLE ${table}_new`);
  db.exec(definition);
  const columns = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((column) => `"${column.name}"`).join(", ");
  db.exec(`INSERT INTO ${table}_new (${columns}) SELECT ${columns} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
  for (const auxiliary of auxiliaries) db.exec(auxiliary.sql);
}

export function removeReview(db: Database): void {
  // 移行で新しい活動日時を捏造せず、最後の提出日時（なければ更新日時）を完了時刻とする。
  db.exec(`INSERT INTO events (issue_id, actor, type, data, created_at)
    SELECT id, 'system', 'status_changed', '{"from":"in_review","to":"done","reason":"レビュー機能の撤去による移行"}',
      COALESCE((SELECT created_at FROM events WHERE issue_id = issues.id AND type = 'status_changed'
        AND json_extract(data, '$.to') = 'in_review' ORDER BY id DESC LIMIT 1), updated_at)
    FROM issues WHERE status = 'in_review'`);
  db.exec(`UPDATE issues SET status = 'done', closed_at = COALESCE(closed_at,
    (SELECT created_at FROM events WHERE issue_id = issues.id AND type = 'status_changed'
      AND json_extract(data, '$.to') = 'in_review' ORDER BY id DESC LIMIT 1), updated_at)
    WHERE status = 'in_review'`);
  db.exec("DELETE FROM workspace_status_names WHERE status = 'in_review'");
  db.exec("DELETE FROM workspace_transition_rules WHERE from_status = 'in_review' OR to_status = 'in_review'");
  db.exec("DELETE FROM workspace_transition_presets WHERE preset = 'review_before_done'");
  for (const view of db.query("SELECT id, filter FROM views").all() as { id: number; filter: string }[]) {
    const filter = JSON.parse(view.filter);
    if (Array.isArray(filter.status)) {
      filter.status = [...new Set(filter.status.map((status: unknown) => status === "in_review" ? "done" : status))];
    } else if (filter.status === "in_review") {
      filter.status = "done";
    }
    db.query("UPDATE views SET filter = ? WHERE id = ?").run(JSON.stringify(filter), view.id);
  }
  for (const table of ["issues", "workspace_status_names", "workspace_transition_rules"]) {
    removeReviewStatusConstraint(db, table);
  }
  db.exec("ALTER TABLE issues DROP COLUMN pr_linked_at");
  db.exec("ALTER TABLE workspaces DROP COLUMN pr_review_enabled");
  db.exec("ALTER TABLE workspaces DROP COLUMN commit_review_enabled");
}
