import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { findIssueRow } from "../src/issue-query";
import { createIssue } from "../src/ops/issues";
import { initWorkspace } from "../src/ops/workspaces";
import { tempDbPath } from "./helpers";

function fixture() {
  const db = openDb(tempDbPath());
  const ws = initWorkspace(db, { path: "/tmp/repos/api-server", key: "API" }).workspace;
  const me = { db, actor: "me" };
  const a = findIssueRow(db, createIssue(me, { workspaceId: ws.id, title: "a" }).id).id;
  const b = findIssueRow(db, createIssue(me, { workspaceId: ws.id, title: "b" }).id).id;
  return { db, ws, a, b };
}

const insertImport = (db: Database, wsId: number, key: string, issueId: number | null) =>
  db
    .query("INSERT INTO issue_imports (workspace_id, source, source_key, issue_id, imported_by, imported_at) VALUES (?, 'github', ?, ?, 'me', '2026-10-07T00:00:00.000Z')")
    .run(wsId, key, issueId);

const insertAttempt = (db: Database, wsId: number, issueId: number, attemptId: string, state: string) =>
  db
    .query(
      `INSERT INTO github_publishes (attempt_id, issue_id, workspace_id, repo, title, body, gh_login, state, started_by, started_at)
       VALUES (?, ?, ?, 'example/api-server', 't', 'b', 'alice', ?, 'me', '2026-10-07T00:00:00.000Z')`,
    )
    .run(attemptId, issueId, wsId, state);

test("issue_imports の経路は既定で import になり、1つの Issue に対応は1件だけ（NULL は複数可）", () => {
  const { db, ws, a } = fixture();
  insertImport(db, ws.id, "example/api-server#1", a);
  expect((db.query("SELECT origin FROM issue_imports").get() as { origin: string }).origin).toBe("import");
  expect(() => insertImport(db, ws.id, "example/api-server#2", a)).toThrow();
  insertImport(db, ws.id, "example/api-server#3", null);
  insertImport(db, ws.id, "example/api-server#4", null);
  expect(() => db.query("UPDATE issue_imports SET origin = 'other'").run()).toThrow();
});

test("github_publishes は Issue ごとに sending・unknown の試行を1件だけ持てる（sent・failed・cleared は何件でも）", () => {
  const { db, ws, a, b } = fixture();
  insertAttempt(db, ws.id, a, "t1", "sent");
  insertAttempt(db, ws.id, a, "t2", "failed");
  insertAttempt(db, ws.id, a, "t3", "sending");
  expect(() => insertAttempt(db, ws.id, a, "t4", "unknown")).toThrow();
  insertAttempt(db, ws.id, b, "t5", "unknown");
  expect(() => insertAttempt(db, ws.id, b, "t1", "sent")).toThrow(); // attempt_id は一意
  expect(() => insertAttempt(db, ws.id, b, "t6", "bogus")).toThrow();
});

test("Workspace に公開先 repo の列があり、既定は未設定", () => {
  const { db, ws } = fixture();
  const row = db.query("SELECT github_repo, github_repo_updated_at, github_repo_updated_by FROM workspaces WHERE id = ?").get(ws.id);
  expect(row).toEqual({ github_repo: null, github_repo_updated_at: null, github_repo_updated_by: null });
});
