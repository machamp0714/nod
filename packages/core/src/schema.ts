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
  // Workspace・Issue を消すとき、ON DELETE CASCADE / SET NULL が参照元を全件走査しないよう、参照列に索引を付ける。
  // 通知の3列に加え、コメントの返信先（parent_id）と子 Issue の親（parent_id）も対象にする
  [
    `CREATE INDEX notifications_issue ON notifications (issue_id)`,
    `CREATE INDEX notifications_event ON notifications (event_id)`,
    `CREATE INDEX notifications_comment ON notifications (comment_id)`,
    `CREATE INDEX comments_parent ON comments (parent_id)`,
    `CREATE INDEX issues_parent ON issues (parent_id)`,
  ],
  [
    // 見積もり（ポイント 1〜100 の整数）と期限（時刻なしの暦日 YYYY-MM-DD）。既存の Issue は NULL（未設定）
    `ALTER TABLE issues ADD COLUMN estimate INTEGER
      CHECK (estimate IS NULL OR (typeof(estimate) = 'integer' AND estimate BETWEEN 1 AND 100))`,
    `ALTER TABLE issues ADD COLUMN due_date TEXT
      CHECK (due_date IS NULL OR (typeof(due_date) = 'text' AND length(due_date) = 10 AND date(due_date) = due_date))`,
  ],
  // Workspace ごとの作業規約（LLM に守らせる Markdown）。未登録は rules = NULL
  [
    `ALTER TABLE workspaces ADD COLUMN rules TEXT`,
    `ALTER TABLE workspaces ADD COLUMN rules_updated_at TEXT`,
    `ALTER TABLE workspaces ADD COLUMN rules_updated_by TEXT`,
  ],
  // 分析の集計。完了した Issue を期間で引き、event を種類と時刻で引く
  [
    `CREATE INDEX issues_closed ON issues (status, closed_at)`,
    `CREATE INDEX events_type_created ON events (type, created_at)`,
  ],
  // アーカイブは status と別の属性。NULL ならアーカイブされていない
  [`ALTER TABLE issues ADD COLUMN archived_at TEXT`],
  // Workspace ごとのラベル定義（色・説明）と、ステータスの表示名。Issue のラベル自体は issue_labels の自由入力のまま
  [
    `CREATE TABLE workspace_labels (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, name)
    )`,
    `CREATE TABLE workspace_status_names (
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('triage','backlog','needs_clarification','todo','in_progress','in_review','done','canceled')),
      name TEXT NOT NULL,
      PRIMARY KEY (workspace_id, status)
    )`,
  ],
  // 作業ログ（nod issue log）の種類。通常のコメントと既存のログは NULL（種類なし）
  [
    `ALTER TABLE comments ADD COLUMN log_kind TEXT
      CHECK (log_kind IS NULL OR log_kind IN ('progress', 'plan', 'rationale', 'command', 'test', 'blocker'))`,
  ],
  // PR 状態（#67）。人・LLM が明示的に更新したときだけ gh から取得して保存する。
  // 最後の成功結果（data は JSON）と最後の失敗を別に持ち、失敗しても前回の結果を残す。
  // started_at は保存済みの取得を始めた時刻で、遅れて終わった古い取得が新しい結果を上書きしないために比べる
  [
    `CREATE TABLE pr_statuses (
      issue_id INTEGER PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
      pr_url TEXT,
      data TEXT,
      fetched_at TEXT,
      fetched_by TEXT,
      error_url TEXT,
      error_code TEXT,
      error_message TEXT,
      error_at TEXT,
      started_at TEXT NOT NULL
    )`,
  ],
  // Workspace ごとの自動化（#71 自動クローズ・#72 自動アーカイブ）。日数が NULL ならそのルールは無効
  [
    `ALTER TABLE workspaces ADD COLUMN auto_close_days INTEGER`,
    `ALTER TABLE workspaces ADD COLUMN auto_archive_days INTEGER`,
    `ALTER TABLE workspaces ADD COLUMN automation_updated_at TEXT`,
    `ALTER TABLE workspaces ADD COLUMN automation_updated_by TEXT`,
    // 最後の活動（停滞の診断・自動クローズ）で Issue ごとに質問を引くため
    `CREATE INDEX questions_issue ON questions (issue_id)`,
  ],
  // 期間の要約（#63・#76）。種類つきの作業ログを種類と時刻で引く
  [`CREATE INDEX comments_log_kind ON comments (log_kind, created_at) WHERE log_kind IS NOT NULL`],
  // Issue の添付（#28）。リンクは URL、ファイルは添付ディレクトリ（NOD_ATTACHMENTS_DIR）の下にコピーした実体への相対パスを持つ。
  // Markdown を nod で読む・複数の Issue で共有するものは従来どおり documents に置く
  [
    `CREATE TABLE issue_attachments (
      id INTEGER PRIMARY KEY,
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('link','file')),
      title TEXT,
      url TEXT,
      file_path TEXT,
      file_name TEXT,
      size INTEGER,
      mime TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK ((kind = 'link' AND url IS NOT NULL AND file_path IS NULL)
        OR (kind = 'file' AND url IS NULL AND file_path IS NOT NULL AND file_name IS NOT NULL AND size IS NOT NULL AND mime IS NOT NULL))
    )`,
    `CREATE INDEX issue_attachments_issue ON issue_attachments (issue_id, id)`,
  ],
  // Issue のリマインダー（#47）。1 Issue・1受け手に1件。期限が来たら通知一覧の取得時に kind='reminder' の通知へ変えて行を消す
  [
    `CREATE TABLE reminders (
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      recipient TEXT NOT NULL,
      remind_at TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (issue_id, recipient)
    )`,
    `CREATE INDEX reminders_due ON reminders (remind_at)`,
  ],
  // LLM の Triage 提案（#62）。提案は Triage の状態・event・通知を変えず、確定は人が accept / decline / duplicate で行う。
  // 1つの Issue に書き手ごとに1件で、同じ書き手の再提案は上書きする。人の確定後も行は残す
  [
    `CREATE TABLE triage_proposals (
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      actor TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('accept', 'decline', 'duplicate')),
      duplicate_of_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
      labels TEXT NOT NULL DEFAULT '[]',
      assignee TEXT,
      priority INTEGER CHECK (priority IS NULL OR priority BETWEEN 0 AND 4),
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (issue_id, actor),
      CHECK ((decision = 'duplicate') = (duplicate_of_id IS NOT NULL))
    )`,
  ],
  // PR の差分（#55）。pr_statuses と同じく、明示的に更新したときだけ gh から取得して Issue ごとに最新1件を保存する。
  // head_sha は取得した差分の HEAD で、PR 状態の取得で別の HEAD を知ったら古い差分として表示しない
  [
    `CREATE TABLE pr_diffs (
      issue_id INTEGER PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
      pr_url TEXT,
      head_sha TEXT,
      base_sha TEXT,
      data TEXT,
      fetched_at TEXT,
      fetched_by TEXT,
      error_url TEXT,
      error_code TEXT,
      error_message TEXT,
      error_at TEXT,
      started_at TEXT NOT NULL
    )`,
  ],
  // PR・コミットによる自動のステータス遷移（#66 PR 連動）。既定は無効（0）。
  // auto_transitions は同じ Issue・同じ PR URL（コミット SHA）で二度遷移させないための記録で、取消後も残す。
  // pr_linked_at は現在の PR を付けた日時。それ以降に一度でも in_review になった Issue は PR 連動の対象にしない（既存行は NULL）
  [
    `ALTER TABLE workspaces ADD COLUMN pr_review_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE issues ADD COLUMN pr_linked_at TEXT`,
    `CREATE TABLE auto_transitions (
      id INTEGER PRIMARY KEY,
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('pr', 'commit')),
      source_key TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      merge_candidate INTEGER NOT NULL DEFAULT 0,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reverted_at TEXT,
      reverted_by TEXT,
      UNIQUE (issue_id, source, source_key)
    )`,
  ],
  // コミット連動（#68 nod git sync）。既定は無効（0）。記録は auto_transitions（source = 'commit'、source_key はコミット SHA）
  [`ALTER TABLE workspaces ADD COLUMN commit_review_enabled INTEGER NOT NULL DEFAULT 0`],
  // 定期Issue（#32）。常駐はせず、人が nod recurring run か web の「今すぐ実行」で1回ずつ起票する。
  // 発生日（ルールのタイムゾーンの暦日）ごとに1件だけ作るよう、作成済みの発生日を occurrences に残す
  [
    `CREATE TABLE recurring_issues (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      template TEXT,
      project_id INTEGER REFERENCES projects(id),
      labels TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 0,
      assignee TEXT,
      cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly', 'monthly')),
      weekday INTEGER CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
      month_day INTEGER CHECK (month_day IS NULL OR month_day BETWEEN 1 AND 31),
      start_date TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX recurring_issues_workspace ON recurring_issues (workspace_id)`,
    `CREATE TABLE recurring_issue_occurrences (
      recurring_id INTEGER NOT NULL REFERENCES recurring_issues(id) ON DELETE CASCADE,
      occurrence_date TEXT NOT NULL,
      issue_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (recurring_id, occurrence_date)
    )`,
  ],
  // Project の進捗報告（#83）。追記のみで、Project を消すと一緒に消える。Project・Issue の状態には連動しない
  [
    `CREATE TABLE project_updates (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX project_updates_project ON project_updates (project_id, created_at, id)`,
  ],
  // ステータスの遷移ルール（#73）。8状態は固定のまま、Workspace ごとに許可しない遷移を人が設定する。行が無ければ制限なし。
  // 禁止する from→to の組と、名前で保存するプリセット（展開しないので違反時にどのルールかを示せる）。needs_clarification は core が切り替えるため対象外
  [
    `CREATE TABLE workspace_transition_rules (
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      from_status TEXT NOT NULL CHECK (from_status IN ('triage','backlog','todo','in_progress','in_review','done','canceled')),
      to_status TEXT NOT NULL CHECK (to_status IN ('triage','backlog','todo','in_progress','in_review','done','canceled')),
      PRIMARY KEY (workspace_id, from_status, to_status),
      CHECK (from_status <> to_status)
    )`,
    `CREATE TABLE workspace_transition_presets (
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      preset TEXT NOT NULL,
      PRIMARY KEY (workspace_id, preset)
    )`,
  ],
  // 他ツールからの Issue 取り込み（#77 nod import github）。取り込み元の Issue と nod の Issue の対応表。
  // 同じ Workspace に同じ取り込み元の Issue を二度作らないために使う。source_key は 'owner/repo#123'（owner/repo は小文字）。
  // Issue を永久削除しても行は残し（issue_id が NULL）、再取り込みで削除した Issue を復活させない
  [
    `CREATE TABLE issue_imports (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('github')),
      source_key TEXT NOT NULL,
      issue_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
      imported_by TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      UNIQUE (workspace_id, source, source_key)
    )`,
  ],
  // Issue の永久削除（#30）の監査ログ。Issue の行は消えるので、ID・タイトルは削除時の値を写して残す。
  // Workspace 単位の記録なので、Workspace を削除すると一緒に消える
  [
    `CREATE TABLE issue_deletions (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      issue_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      archived_at TEXT NOT NULL,
      deleted_by TEXT NOT NULL,
      deleted_at TEXT NOT NULL
    )`,
    `CREATE INDEX issue_deletions_workspace ON issue_deletions (workspace_id, id)`,
  ],
  // Project の健全性（#79）。進捗報告に添える。現在の健全性は健全性つきの最新の報告の値で、projects には持たない
  [
    `ALTER TABLE project_updates ADD COLUMN health TEXT CHECK (health IS NULL OR health IN ('on_track', 'at_risk', 'off_track'))`,
  ],
];
