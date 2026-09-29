import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openDb } from "../src/db";
import { initWorkspace, removeWorkspace } from "../src/ops/workspaces";
import { tempDbPath } from "./helpers";

// 索引の先頭の列
function indexedColumns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA index_list(${table})`).all() as { name: string }[]).map(
    (i) => (db.query(`PRAGMA index_info(${JSON.stringify(i.name)})`).all() as { name: string }[])[0]!.name,
  );
}

// 通知は issue・event・comment を、コメントと Issue は親を参照する。参照先を消すたびに
// 参照元を全件走査しないよう、参照列に索引がある
test("削除で辿る参照列に索引がある", () => {
  const db = openDb(tempDbPath());
  expect(indexedColumns(db, "notifications")).toEqual(expect.arrayContaining(["issue_id", "event_id", "comment_id"]));
  expect(indexedColumns(db, "comments")).toContain("parent_id");
  expect(indexedColumns(db, "issues")).toContain("parent_id");
});

// 通知の多い Workspace の Issue を一度に作る。1 Issue に event・comment 各 PER 件と、その通知
function seed(db: Database, workspaceId: number, issues: number, per: number, ts = "2026-01-01T00:00:00.000Z") {
  const issue = db.query(
    "INSERT INTO issues (workspace_id, number, title, status, created_by, created_at, updated_at) VALUES (?, ?, ?, 'todo', 'me', ?, ?)",
  );
  const event = db.query("INSERT INTO events (issue_id, actor, type, data, created_at) VALUES (?, 'claude-code', 'status_changed', '{}', ?)");
  const comment = db.query("INSERT INTO comments (issue_id, author, body, created_at) VALUES (?, 'claude-code', 'c', ?)");
  const notify = db.query(
    `INSERT INTO notifications (recipient, issue_id, kind, event_type, event_id, comment_id, actor, created_at)
     VALUES ('me', ?, 'issue_change', ?, ?, ?, 'claude-code', ?)`,
  );
  db.transaction(() => {
    for (let n = 1; n <= issues; n++) {
      const id = Number(issue.run(workspaceId, n, `Issue ${n}`, ts, ts).lastInsertRowid);
      for (let k = 0; k < per; k++) {
        notify.run(id, "status_changed", Number(event.run(id, ts).lastInsertRowid), null, ts);
        notify.run(id, "comment_added", null, Number(comment.run(id, ts).lastInsertRowid), ts);
      }
    }
  })();
}

test("通知が数千件ある Workspace・Issue の削除が参照元を全件走査しない", () => {
  const db = openDb(tempDbPath());
  const target = initWorkspace(db, { path: "/tmp/repos/target" }).workspace;
  const other = initWorkspace(db, { path: "/tmp/repos/other" }).workspace;
  seed(db, target.id, 1000, 3);
  seed(db, other.id, 1000, 3);
  expect((db.query("SELECT count(*) AS n FROM notifications").get() as { n: number }).n).toBe(12000);

  const oneIssue = performance.now();
  db.query("DELETE FROM issues WHERE workspace_id = ? AND number = 1").run(other.id);
  const issueMs = performance.now() - oneIssue;

  const start = performance.now();
  expect(removeWorkspace(db, target.key).deletedIssues).toBe(1000);
  const workspaceMs = performance.now() - start;

  console.log(`通知 12000 件: Issue 1 件の削除 ${issueMs.toFixed(1)}ms / Issue 1000 件の Workspace 削除 ${workspaceMs.toFixed(1)}ms`);
  expect((db.query("SELECT count(*) AS n FROM notifications").get() as { n: number }).n).toBe(5994);
  // 索引なしでは Workspace 削除が数秒かかる（参照先 1 行ごとに参照元を全件走査）。索引ありは 100ms 未満。
  // 負荷の高い環境の揺れを見込み、上限には余裕を持たせる
  expect(workspaceMs).toBeLessThan(1000);
});
