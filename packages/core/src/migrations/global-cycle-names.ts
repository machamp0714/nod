import type { Database } from "bun:sqlite";

// Cycle の名前を全体で一意にする前に、Workspace 間で重なる名前を「名前 · キー」に改名する（各名前で ID の最も小さい行は残す）。
// 改名後の名前がほかと重なるなら「名前 · キー · ID」にし、それでも重なれば番号を足して必ず一意にする
export function renameDuplicateCycleNames(db: Database): void {
  const rows = db
    .query(
      `SELECT c.id, c.name, w.key FROM cycles c JOIN workspaces w ON w.id = c.workspace_id
       WHERE c.id NOT IN (SELECT min(id) FROM cycles GROUP BY name) ORDER BY c.id`,
    )
    .all() as { id: number; name: string; key: string }[];
  const taken = db.query("SELECT 1 FROM cycles WHERE name = ?");
  const rename = db.query("UPDATE cycles SET name = ? WHERE id = ?");
  for (const r of rows) {
    let name = `${r.name} · ${r.key}`;
    if (taken.get(name)) name = `${r.name} · ${r.key} · ${r.id}`;
    for (let n = 2; taken.get(name); n++) name = `${r.name} · ${r.key} · ${r.id} · ${n}`;
    rename.run(name, r.id);
  }
}
