import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openDb, SCHEMA_VERSION, schemaVersion, tx } from "../src/db";
import { codeOf, tempDbPath } from "./helpers";

describe("openDb", () => {
  test("issues の status は needs_clarification を受け付け、知らない値は拒む", () => {
    const db = openDb(tempDbPath());
    db.query("INSERT INTO workspaces (key, name, path, created_at, color) VALUES ('API', 'api', '/tmp/api', '', '#7C5CFF')").run();
    const insert = (n: number, status: string) =>
      db
        .query(
          "INSERT INTO issues (workspace_id, number, title, status, created_by, created_at, updated_at) VALUES (1, ?, 't', ?, 'me', '', '')",
        )
        .run(n, status);
    expect(() => insert(1, "needs_clarification")).not.toThrow();
    expect(() => insert(2, "wip")).toThrow();
  });
  test("pragma を設定し、スキーマを最新にする", () => {
    const db = openDb(tempDbPath());
    expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect((db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(tables).toEqual([
      "auto_transitions",
      "comments",
      "document_links",
      "documents",
      "events",
      "issue_attachments",
      "issue_labels",
      "issues",
      "notifications",
      "plan_steps",
      "plan_tasks",
      "pr_diffs",
      "pr_statuses",
      "projects",
      "questions",
      "relations",
      "reminders",
      "subscriptions",
      "templates",
      "triage_proposals",
      "views",
      "workspace_labels",
      "workspace_status_names",
      "workspaces",
    ]);
  });

  test("開き直してもマイグレーションを二重に適用しない", () => {
    const path = tempDbPath();
    openDb(path).close();
    const db = openDb(path);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  test("DB の版が nod より新しければ SCHEMA_TOO_NEW", () => {
    const path = tempDbPath();
    const raw = new Database(path, { create: true });
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(codeOf(() => openDb(path))).toBe("SCHEMA_TOO_NEW");
  });
});

describe("tx", () => {
  test("途中で失敗したら何も残さない", () => {
    const db = openDb(tempDbPath());
    expect(() =>
      tx(db, () => {
        db.query("INSERT INTO views (name) VALUES ('仕事')").run();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect((db.query("SELECT count(*) AS n FROM views").get() as { n: number }).n).toBe(0);
  });

  test("ほかの接続が書き込み中でロックが取れなければ DB_BUSY", () => {
    const path = tempDbPath();
    const a = openDb(path);
    a.exec("BEGIN IMMEDIATE");
    const b = openDb(path, { busyTimeoutMs: 50 });
    expect(codeOf(() => tx(b, () => b.query("INSERT INTO views (name) VALUES ('x')").run()))).toBe("DB_BUSY");
    a.exec("ROLLBACK");
  });
});
