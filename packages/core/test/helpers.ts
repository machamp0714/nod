import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpCtx } from "../src/ctx";
import { openDb } from "../src/db";
import { findIssueRow } from "../src/issue-query";
import { initWorkspace } from "../src/ops/workspaces";

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "nod-test-")), "nod.db");
}

export function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

export function setup() {
  const db = openDb(tempDbPath());
  const ws = initWorkspace(db, { path: "/tmp/repos/api-server" }).workspace;
  const me: OpCtx = { db, actor: "me" };
  const llm: OpCtx = { db, actor: "claude-code" };
  return { db, ws, me, llm };
}

export function eventsOf(db: Database, ref: string): { type: string; actor: string; data: any }[] {
  const row = findIssueRow(db, ref);
  const rows = db.query("SELECT type, actor, data FROM events WHERE issue_id = ? ORDER BY id").all(row.id) as {
    type: string;
    actor: string;
    data: string;
  }[];
  return rows.map((e) => ({ type: e.type, actor: e.actor, data: JSON.parse(e.data) }));
}

// Project の操作は Task 6 で作るため、テストでは行を直接足す
export function addProjectRow(db: Database, name: string): number {
  const { lastInsertRowid } = db
    .query("INSERT INTO projects (name, created_by, created_at, updated_at) VALUES (?, 'me', '', '')")
    .run(name);
  return Number(lastInsertRowid);
}
