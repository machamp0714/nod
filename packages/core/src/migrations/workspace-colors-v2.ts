import type { Database } from "bun:sqlite";
import { firstUnusedColor, workspaceColorCandidatesV1 } from "../workspace-colors";

// 呼び出し元が版確認・IMMEDIATE transaction・user_version更新を行う。
export function migrateWorkspaceColorsV2(db: Database): void {
  db.exec(`ALTER TABLE workspaces ADD COLUMN color TEXT
    CHECK (color IS NULL OR (
      length(color) = 7 AND substr(color, 1, 1) = '#'
      AND substr(color, 2) NOT GLOB '*[^0-9A-F]*'
    ))`);
  const rows = db.query("SELECT id FROM workspaces ORDER BY created_at, id").all() as { id: number }[];
  const candidates = workspaceColorCandidatesV1();
  const used = new Set<string>();
  const update = db.query("UPDATE workspaces SET color = ? WHERE id = ?");
  for (const { id } of rows) {
    const color = firstUnusedColor(used, candidates);
    update.run(color, id);
    used.add(color);
  }
  const counts = db.query("SELECT count(*) AS total, count(color) AS colored, count(DISTINCT color) AS unique_colors FROM workspaces").get() as { total: number; colored: number; unique_colors: number };
  if (counts.total !== counts.colored || counts.total !== counts.unique_colors) throw new Error("Workspace 色の移行結果が不正です");
  db.exec("CREATE UNIQUE INDEX workspaces_color_unique ON workspaces(color)");
  // backfillのため列自体はnullable。移行後のNULLはtriggerで拒否し、FKを保ったまま必須にする。
  db.exec(`CREATE TRIGGER workspaces_color_required_insert
    BEFORE INSERT ON workspaces WHEN NEW.color IS NULL
    BEGIN SELECT RAISE(ABORT, 'Workspace color is required'); END`);
  db.exec(`CREATE TRIGGER workspaces_color_required_update
    BEFORE UPDATE OF color ON workspaces WHEN NEW.color IS NULL
    BEGIN SELECT RAISE(ABORT, 'Workspace color is required'); END`);
}
