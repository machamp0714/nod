import type { Database } from "bun:sqlite";
import { migrateWorkspaceColorsV2 } from "./migrations/workspace-colors-v2";

export type MigrationStep = string | ((db: Database) => void);

// MIGRATIONS[n] は、スキーマの版 n から n + 1 に上げる SQL・移行関数の並び
export const MIGRATIONS: MigrationStep[][] = [
  [
    `CREATE TABLE workspaces (
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL UNIQUE,
      next_number INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'started', 'completed', 'canceled')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE issues (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL CHECK (status IN ('triage', 'backlog', 'needs_clarification', 'todo', 'in_progress', 'in_review', 'done', 'canceled')),
      priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
      assignee TEXT,
      agent_state TEXT CHECK (agent_state IN ('working', 'awaiting_input', 'error', 'done')),
      parent_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      snoozed_until TEXT,
      pr_url TEXT,
      branch TEXT,
      worktree TEXT,
      plan_source TEXT,
      close_reason TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      closed_at TEXT,
      UNIQUE (workspace_id, number)
    )`,
    `CREATE TABLE issue_labels (
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      PRIMARY KEY (issue_id, label)
    )`,
    `CREATE TABLE relations (
      from_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      to_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('blocks', 'related', 'duplicate')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id, type)
    )`,
    `CREATE TABLE plan_tasks (
      id INTEGER PRIMARY KEY,
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'doing', 'done', 'skipped'))
    )`,
    `CREATE TABLE plan_steps (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'doing', 'done', 'skipped'))
    )`,
    `CREATE TABLE documents (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('spec', 'plan', 'doc')),
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE document_links (
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      CHECK ((issue_id IS NULL) <> (project_id IS NULL))
    )`,
    `CREATE UNIQUE INDEX document_links_issue ON document_links (document_id, issue_id) WHERE issue_id IS NOT NULL`,
    `CREATE UNIQUE INDEX document_links_project ON document_links (document_id, project_id) WHERE project_id IS NOT NULL`,
    `CREATE TABLE questions (
      id INTEGER PRIMARY KEY,
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      asked_by TEXT NOT NULL,
      asked_at TEXT NOT NULL,
      answer TEXT,
      answered_by TEXT,
      answered_at TEXT
    )`,
    `CREATE TABLE comments (
      id INTEGER PRIMARY KEY,
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      actor TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE views (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT,
      filter TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE templates (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX issues_status ON issues (status)`,
    `CREATE INDEX events_issue ON events (issue_id, id)`,
  ],
  [migrateWorkspaceColorsV2],
  // スレッド返信。既存コメントは parent_id = NULL のスレッド親になる
  [
    `ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE`,
    `CREATE INDEX comments_issue ON comments (issue_id, id)`,
  ],
  // スレッドの解決済み化。スレッドの親の行にだけ値を持つ
  [`ALTER TABLE comments ADD COLUMN resolved_at TEXT`, `ALTER TABLE comments ADD COLUMN resolved_by TEXT`],
  // 購読（#45）と通知（#42）。kind に CHECK を付けないのは、後から LLM の完了通知・リマインダーを足すため。
  // snoozed_until（#43）と deleted_at（#44）は列だけ先に用意し、一覧はこれらを見て絞る
  [
    `CREATE TABLE subscriptions (
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      subscriber TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (issue_id, subscriber)
    )`,
    `CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      recipient TEXT NOT NULL,
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
      comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
      actor TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      read_at TEXT,
      snoozed_until TEXT,
      deleted_at TEXT,
      UNIQUE (recipient, event_id),
      UNIQUE (recipient, comment_id)
    )`,
    `CREATE INDEX notifications_recipient ON notifications (recipient, read_at, created_at)`,
  ],
];
