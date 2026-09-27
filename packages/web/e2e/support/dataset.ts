import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// データセット（e2e/datasets/<名前>.ts）の形。e2e の server（Bun）が、DB を空にした直後に呼ぶ。
// core の関数を @nod/core から直接 import して使う。core にない変更（Project のステータスなど）は SQL で書いてよい。
export interface DatasetContext {
  db: Database; // e2e の server とは別の接続
  dir: string; // e2e の一時ディレクトリ（NOD_E2E_DIR）
  repo(name: string): string; // <dir>/repos/<name> を作って返す。Workspace の path に使う
  writeFile(path: string, body: string): string; // <dir> からの相対パスにファイルを書き、絶対パスを返す
}

export type Dataset = (ctx: DatasetContext) => void;

export function datasetContext(db: Database, dir: string): DatasetContext {
  return {
    db,
    dir,
    repo(name) {
      const path = join(dir, "repos", name);
      mkdirSync(path, { recursive: true });
      return path;
    },
    writeFile(path, body) {
      const abs = join(dir, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
      return abs;
    },
  };
}

// すべての行を消す。server が同じファイルを開いたままなので、ファイルは消さない。
// スキーマの主キーは AUTOINCREMENT ではないため、消した後の ID は 1 から振り直される。
// foreign_keys はトランザクションの中で変えられないため、トランザクションの外で切り替える。
export function wipe(db: Database): void {
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  db.run("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      for (const { name } of tables) db.run(`DELETE FROM "${name}"`);
    })();
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}
