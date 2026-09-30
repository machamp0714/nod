import { NodError } from "./errors";
import { isNoneRef, NONE_REF } from "./none-ref";
import { STATUSES, type Status } from "./types";

// GET /api/issues のクエリパラメータと View の filter に共通する絞り込み条件。キーの名前はクエリパラメータの名前と同じ
export interface IssueQuery {
  blocked?: boolean; // false はブロックされていない Issue
  q?: string; // ID・タイトル・説明の文字列検索
  workspace?: string[]; // Workspace のキー。どれかに合うもの
  status?: Status[]; // どれかに合うもの。省くとすべてのステータス
  project?: string; // Project の名前か ID
  milestone?: string; // Milestone の数字の ID か、Milestone のない Issue だけにする "none"
  cycle?: string; // Cycle の ID か、Cycle のない Issue だけにする "none"。名前・current は Workspace を1つに絞ったときだけ
  label?: string[]; // すべてを持つもの
  ready?: boolean; // true なら、担当者を問わず着手できる Issue だけ
  delegated?: boolean; // true なら、担当が LLM で done/canceled 以外の Issue（委任中）だけ
  assignee?: string[]; // 担当の名前。どれかに合うもの。"none" は未割り当て。大文字小文字は区別する
  archived?: boolean; // true ならアーカイブ済みの Issue だけ。省くとアーカイブ済みを除く
}

const QUERY_KEYS = ["workspace", "status", "project", "milestone", "cycle", "label", "ready", "q", "blocked", "delegated", "assignee", "archived"];

function invalid(message: string): NodError {
  return new NodError("INVALID_ARGS", message);
}

function stringList(value: unknown, key: string, splitComma: boolean): string[] | undefined {
  if (value === undefined) return undefined;
  const list: unknown[] = Array.isArray(value) ? value : [value];
  if (list.some((v) => typeof v !== "string")) throw invalid(`${key} は文字列か文字列の配列で指定してください`);
  const items = (list as string[])
    .flatMap((v) => (splitComma ? v.split(",") : [v]))
    .map((v) => v.trim())
    .filter(Boolean);
  return items.length ? [...new Set(items)] : undefined;
}

export function validateIssueQuery(value: unknown): IssueQuery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid('絞り込み条件はオブジェクトで指定してください（例: {"status": ["todo"], "ready": true}）');
  }
  const raw = value as Record<string, unknown>;
  const unknownKeys = Object.keys(raw).filter((k) => !QUERY_KEYS.includes(k));
  if (unknownKeys.length) {
    throw invalid(`絞り込み条件に ${unknownKeys.join(", ")} は使えません（使えるもの: ${QUERY_KEYS.join(", ")}）`);
  }
  const q: IssueQuery = {};
  if (raw.q !== undefined) {
    if (typeof raw.q !== "string") throw invalid("q は文字列で指定してください");
    if (raw.q.trim()) q.q = raw.q.trim();
  }
  const workspace = stringList(raw.workspace, "workspace", true);
  if (workspace) q.workspace = [...new Set(workspace.map((k) => k.toUpperCase()))];
  const status = stringList(raw.status, "status", true);
  if (status) {
    const bad = status.filter((s) => !(STATUSES as readonly string[]).includes(s));
    if (bad.length) throw invalid(`ステータス「${bad.join(", ")}」は使えません（使えるもの: ${STATUSES.join(", ")}）`);
    q.status = status as Status[];
  }
  if (raw.project !== undefined) {
    if (typeof raw.project !== "string" || !raw.project.trim()) {
      throw invalid("project には Project の名前か ID を文字列で指定してください");
    }
    q.project = raw.project;
  }
  if (raw.milestone !== undefined) {
    const value = typeof raw.milestone === "number" ? String(raw.milestone) : raw.milestone;
    if (typeof value === "string" && isNoneRef(value)) q.milestone = NONE_REF;
    else if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
      throw invalid("milestone には Milestone の ID（正の整数）か none を指定してください");
    } else q.milestone = value;
  }
  if (raw.cycle !== undefined) {
    if (typeof raw.cycle !== "string" || !raw.cycle.trim()) {
      throw invalid("cycle には Cycle の ID を文字列で指定してください");
    }
    q.cycle = isNoneRef(raw.cycle) ? NONE_REF : raw.cycle.trim();
  }
  const label = stringList(raw.label, "label", false);
  if (label) q.label = label;
  if (raw.blocked !== undefined) {
    if (typeof raw.blocked !== "boolean") throw invalid("blocked は true か false で指定してください");
    q.blocked = raw.blocked;
  }
  if (raw.ready !== undefined) {
    if (typeof raw.ready !== "boolean") throw invalid("ready は true か false で指定してください");
    if (raw.ready) q.ready = true;
  }
  if (raw.delegated !== undefined) {
    if (typeof raw.delegated !== "boolean") throw invalid("delegated は true か false で指定してください");
    if (raw.delegated) q.delegated = true;
  }
  const assignee = stringList(raw.assignee, "assignee", true);
  if (assignee) q.assignee = [...new Set(assignee.map((name) => (isNoneRef(name) ? NONE_REF : name)))];
  if (raw.archived !== undefined) {
    if (typeof raw.archived !== "boolean") throw invalid("archived は true か false で指定してください");
    if (raw.archived) q.archived = true;
  }
  return q;
}

export function issueQueryFromParams(params: URLSearchParams): IssueQuery {
  const raw: Record<string, unknown> = Object.create(null);
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    const last = values[values.length - 1] ?? "";
    if (key === "project" || key === "milestone" || key === "cycle" || key === "q") {
      raw[key] = last;
    } else if (key === "ready" || key === "blocked" || key === "delegated" || key === "archived") {
      if (!["true", "1", "false", "0"].includes(last)) {
        throw invalid(`${key} は true か false で指定してください（受け取った値: ${last}）`);
      }
      raw[key] = last === "true" || last === "1";
    } else {
      raw[key] = values;
    }
  }
  return validateIssueQuery(raw);
}
