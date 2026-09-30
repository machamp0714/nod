import type { Database } from "bun:sqlite";
import { HUMAN_ACTOR } from "../ctx";
import { NodError } from "../errors";
import { formatIssueId } from "../issue-query";
import { recordedTimestamp } from "../recorded-time";
import type { Status } from "../types";
import { issueScope, llmAssignee } from "./stats";

// 期間の要約（#63・#76）。LLM の推論は使わず、events と作業ログから決定的に組み立てる。読み取り専用
export const SUMMARY_KINDS = [
  "completed",
  "submitted",
  "rejected",
  "started",
  "blocker",
  "asked",
  "answered",
  "created",
  "canceled",
  "archived",
] as const;
export type SummaryKind = (typeof SUMMARY_KINDS)[number];

export const SUMMARY_KIND_LABEL: Record<SummaryKind, string> = {
  completed: "完了",
  submitted: "レビュー提出",
  rejected: "差し戻し",
  started: "着手",
  blocker: "ブロッカー",
  asked: "質問",
  answered: "回答",
  created: "新規起票",
  canceled: "キャンセル",
  archived: "アーカイブ",
};

export const SUMMARY_DEFAULT_SINCE = "24h";
export const SUMMARY_DEFAULT_LIMIT = 20;
export const SUMMARY_MAX_LIMIT = 200;
const MAX_RANGE_MS = 90 * 86_400_000;

export interface SummaryQuery {
  since?: string; // 24h・7d・2w のような直近の長さか ISO 日時。省略時は 24h
  workspace?: string[]; // Workspace のキー。どれかに合うもの
  project?: string; // Project の名前か ID
  cycle?: string; // Cycle の ID。名前・current は Workspace を1つに絞ったときだけ（current は実行環境のローカルの今日）
  limit?: number; // 種類ごとに返す件数。省略時は 20
  includeArchived?: boolean; // アーカイブ済み Issue の動きも含める
  now?: Date; // テスト用。期間の終点
}

export type ActorKind = "human" | "llm";

export interface SummaryItem {
  kind: SummaryKind;
  at: string;
  issueId: string;
  title: string;
  status: Status;
  assignee: string | null;
  archived: boolean;
  // 動きの主体。完了は人がレビューで確定するため、担当の LLM がいればその LLM に帰属させる
  actor: string;
  actorKind: ActorKind;
  recordedBy: string; // 記録した書き手（完了では確定した人）
  // ステータスの遷移（完了・レビュー提出・着手・キャンセル）。それ以外は null
  from: Status | null;
  to: Status | null;
  // 種類ごとの補足：差し戻し理由・質問と回答の本文・ブロッカーの内容・状態の遷移元
  detail: string | null;
}

export interface SummarySection {
  kind: SummaryKind;
  label: string;
  total: number;
  human: number;
  llm: number;
  more: number; // items に入らなかった件数（「他N件」）
  items: SummaryItem[];
}

export interface Summary {
  since: string;
  until: string;
  limit: number;
  includeArchived: boolean;
  totals: { total: number; human: number; llm: number };
  sections: SummarySection[];
}

const QUERY_KEYS = ["since", "workspace", "project", "cycle", "limit", "includeArchived"];

function invalid(message: string): NodError {
  return new NodError("INVALID_ARGS", message);
}

// API のクエリパラメータを SummaryQuery にする。workspace だけは複数指定できる
export function summaryQueryFromParams(params: URLSearchParams): SummaryQuery {
  const unknownKeys = [...new Set(params.keys())].filter((k) => !QUERY_KEYS.includes(k));
  if (unknownKeys.length) throw invalid(`${unknownKeys.join(", ")} は受け付けません（使えるもの: ${QUERY_KEYS.join(", ")}）`);
  const single = (key: string) => {
    const values = params.getAll(key);
    if (values.length > 1) throw invalid(`${key} は1つだけ指定してください`);
    return values[0];
  };
  const q: SummaryQuery = {};
  const since = single("since");
  if (since !== undefined) q.since = since;
  const project = single("project");
  if (project !== undefined) q.project = project;
  const cycle = single("cycle");
  if (cycle !== undefined) q.cycle = cycle;
  const limit = single("limit");
  if (limit !== undefined) q.limit = parseLimit(limit);
  const archived = single("includeArchived");
  if (archived !== undefined) {
    if (archived !== "true" && archived !== "false") throw invalid(`includeArchived は true か false で指定してください（${archived}）`);
    q.includeArchived = archived === "true";
  }
  const workspace = params.getAll("workspace").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  if (workspace.length) q.workspace = workspace;
  return q;
}

export function parseLimit(value: string): number {
  if (!/^\d+$/.test(value)) throw invalid(`件数は 1〜${SUMMARY_MAX_LIMIT} の整数で指定してください（${value}）`);
  return Number(value);
}

const UNIT_MS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

// 期間の下限（UTC の ISO 文字列）。直近の長さ（24h・7d・2w）か ISO 日時を受け付け、最長 90 日
export function parseSince(value: string, now: Date = new Date()): string {
  const end = now.getTime();
  const rel = /^([1-9]\d{0,3})([hdw])$/.exec(value);
  const at = rel ? end - Number(rel[1]) * UNIT_MS[rel[2]!]! : recordedTimestamp(value);
  if (at === null) {
    throw invalid(`期間は 24h・7d・2w のような長さか、ISO 日時（例: 2026-09-29T09:00:00+09:00）で指定してください（${value}）`);
  }
  if (at > end) throw invalid(`期間の開始（${value}）が現在より後です`);
  if (end - at > MAX_RANGE_MS) throw invalid(`期間は最長 90 日です（${value}）`);
  return new Date(at).toISOString();
}

export function actorKind(actor: string): ActorKind {
  return actor === HUMAN_ACTOR ? "human" : "llm";
}

interface Row {
  src: "event" | "log";
  type: string;
  actor: string;
  data: string | null;
  body: string | null;
  created_at: string;
  ws_key: string;
  number: number;
  title: string;
  status: Status;
  assignee: string | null;
  archived_at: string | null;
  worker: string | null;
  rejected_after: number | null;
}

const EVENT_TYPES = ["status_changed", "review_rejected", "question_asked", "question_answered", "agent_state_changed", "created", "archived"];

// event を要約の種類に振り分ける。対象外は null
function classify(row: Row): { kind: SummaryKind; detail: string | null } | null {
  if (row.src === "log") return { kind: "blocker", detail: row.body };
  const data = JSON.parse(row.data ?? "{}") as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  switch (row.type) {
    case "status_changed":
      if (data.to === "done") return { kind: "completed", detail: null };
      if (data.to === "canceled") return { kind: "canceled", detail: text(data.reason) };
      if (data.to === "in_review") return { kind: "submitted", detail: null };
      // 差し戻し（直後に review_rejected が続く in_review→in_progress）は差し戻しとして数え、着手に重ねない
      if (data.to === "in_progress" && !(data.from === "in_review" && row.rejected_after)) return { kind: "started", detail: null };
      return null;
    case "review_rejected":
      return { kind: "rejected", detail: text(data.reason) };
    case "question_asked":
      return { kind: "asked", detail: text(data.question) };
    case "question_answered":
      return { kind: "answered", detail: text(data.answer) };
    case "agent_state_changed":
      return data.to === "error" ? { kind: "blocker", detail: text(data.reason) } : null;
    case "created":
      return { kind: "created", detail: null };
    case "archived":
      return { kind: "archived", detail: text(data.reason) };
  }
  return null;
}

// 要約で読む events と作業ログを1本の UNION ALL にする。EXPLAIN で索引を確かめられるよう SQL と引数を返す
export function summaryStatement(db: Database, q: Pick<SummaryQuery, "workspace" | "project" | "cycle">, since: string, until: string, includeArchived: boolean): { sql: string; params: (string | number)[] } {
  const scope = issueScope(db, q);
  // アーカイブ操作そのものは、アーカイブ済みを除くときも「アーカイブ」に出す
  const archivedEvents = includeArchived ? "" : " AND (i.archived_at IS NULL OR e.type = 'archived')";
  const archivedLogs = includeArchived ? "" : " AND i.archived_at IS NULL";
  const issueCols = "w.key AS ws_key, i.number, i.title, i.status, i.assignee, i.archived_at";

  // 完了は llmStats と同じく、完了より前で最後に LLM を担当にした記録へ帰属させる（LLM がいなければ書き手）。
  // 差し戻しは同じ Issue で次に続く status_changed / review_rejected が review_rejected かで見分ける。
  // 質問と回答の本文は questions にあるため、event の question_id から引く
  const sql = `SELECT * FROM (
      SELECT 'event' AS src, e.id AS sort_id, e.type, e.actor, e.created_at, ${issueCols},
        CASE WHEN e.type = 'status_changed' AND json_extract(e.data, '$.to') = 'done' THEN
          (SELECT json_extract(a.data, '$.to') FROM events a WHERE a.issue_id = e.issue_id AND a.type = 'assignee_changed'
            AND ${llmAssignee("a")} AND a.id < e.id ORDER BY a.id DESC LIMIT 1) END AS worker,
        CASE WHEN e.type = 'status_changed' AND json_extract(e.data, '$.from') = 'in_review' AND json_extract(e.data, '$.to') = 'in_progress' THEN
          (SELECT r.type = 'review_rejected' FROM events r WHERE r.issue_id = e.issue_id AND r.id > e.id
            AND r.type IN ('status_changed', 'review_rejected') ORDER BY r.id LIMIT 1) END AS rejected_after,
        CASE e.type
          WHEN 'question_asked' THEN json_set(e.data, '$.question',
            (SELECT q.question FROM questions q WHERE q.id = json_extract(e.data, '$.question_id')))
          WHEN 'question_answered' THEN json_set(e.data, '$.answer',
            (SELECT q.answer FROM questions q WHERE q.id = json_extract(e.data, '$.question_id')))
          ELSE e.data END AS data,
        NULL AS body
      FROM events e JOIN issues i ON i.id = e.issue_id JOIN workspaces w ON w.id = i.workspace_id
      WHERE e.type IN (${EVENT_TYPES.map(() => "?").join(",")}) AND e.created_at >= ? AND e.created_at <= ?${scope.where}${archivedEvents}
      UNION ALL
      SELECT 'log', c.id, 'work_log', c.author, c.created_at, ${issueCols}, NULL, NULL, NULL, c.body
      FROM comments c JOIN issues i ON i.id = c.issue_id JOIN workspaces w ON w.id = i.workspace_id
      WHERE c.log_kind = 'blocker' AND c.created_at >= ? AND c.created_at <= ?${scope.where}${archivedLogs}
    ) ORDER BY created_at DESC, sort_id DESC`;
  return { sql, params: [...EVENT_TYPES, since, until, ...scope.params, since, until, ...scope.params] };
}

// 期間内の動きを種類ごとに数え、新しい順に limit 件まで並べる
export function recentSummary(db: Database, q: SummaryQuery = {}): Summary {
  const now = q.now ?? new Date();
  const since = parseSince(q.since ?? SUMMARY_DEFAULT_SINCE, now);
  const until = now.toISOString();
  const limit = q.limit ?? SUMMARY_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SUMMARY_MAX_LIMIT) {
    throw invalid(`件数は 1〜${SUMMARY_MAX_LIMIT} の整数で指定してください（${limit}）`);
  }
  const includeArchived = q.includeArchived ?? false;
  const stmt = summaryStatement(db, q, since, until, includeArchived);
  const rows = db.query(stmt.sql).all(...stmt.params) as Row[];

  const sections = new Map<SummaryKind, SummarySection>(SUMMARY_KINDS.map((kind) => [
    kind,
    { kind, label: SUMMARY_KIND_LABEL[kind], total: 0, human: 0, llm: 0, more: 0, items: [] },
  ]));
  for (const row of rows) {
    const found = classify(row);
    if (!found) continue;
    const section = sections.get(found.kind)!;
    const actor = row.worker && actorKind(row.worker) === "llm" ? row.worker : row.actor;
    const kind = actorKind(actor);
    const transition = row.type === "status_changed" ? (JSON.parse(row.data ?? "{}") as { from?: Status; to?: Status }) : null;
    section.total++;
    section[kind]++;
    if (section.items.length < limit) {
      section.items.push({
        kind: found.kind,
        at: row.created_at,
        issueId: formatIssueId(row.ws_key, row.number),
        title: row.title,
        status: row.status,
        assignee: row.assignee,
        archived: row.archived_at !== null,
        actor,
        actorKind: kind,
        recordedBy: row.actor,
        from: transition?.from ?? null,
        to: transition?.to ?? null,
        detail: found.detail,
      });
    } else {
      section.more++;
    }
  }
  const list = [...sections.values()];
  return {
    since,
    until,
    limit,
    includeArchived,
    totals: {
      total: list.reduce((n, s) => n + s.total, 0),
      human: list.reduce((n, s) => n + s.human, 0),
      llm: list.reduce((n, s) => n + s.llm, 0),
    },
    sections: list,
  };
}
