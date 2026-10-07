import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { now } from "../ctx";
import { NodError } from "../errors";
import { findIssueRow, formatIssueId } from "../issue-query";

// Toggl Track の打刻（NOD-6）。nod のサーバーが Toggl の API を呼び、トークンはブラウザに渡さない。
// 打刻の状態は DB に保存しない

// Toggl の API への要求。path は https://api.track.toggl.com/api/v9 からの相対
export interface TogglRequest {
  method: "GET" | "POST" | "PATCH";
  path: string;
  token: string;
  body?: unknown;
}
// Toggl の API の応答。HTTP の失敗（4xx・5xx）も ok で返し、状態コードで区別する
export type TogglResponse =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "network_error"; detail: string } // 接続できない
  | { kind: "timeout" }; // 時間切れで止めた
// Toggl の API を呼ぶ部分。テストと e2e は偽のクライアントを渡し、本物の Toggl には触れない
export type TogglClient = (req: TogglRequest) => Promise<TogglResponse>;

export const TOGGL_API_BASE = "https://api.track.toggl.com/api/v9";
export const TOGGL_TIMEOUT_MS = 15_000;

// 本物の Toggl Track API v9 を呼ぶクライアント。Basic 認証（<token>:api_token）で送る
export function createTogglClient(base = TOGGL_API_BASE, timeoutMs = TOGGL_TIMEOUT_MS): TogglClient {
  return async ({ method, path, token, body }) => {
    const headers: Record<string, string> = { Authorization: `Basic ${Buffer.from(`${token}:api_token`).toString("base64")}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err.name === "TimeoutError") return { kind: "timeout" };
      return { kind: "network_error", detail: err.message ?? String(e) };
    }
    const text = await res.text().catch(() => "");
    let parsed: unknown = text;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      // JSON でない本文（エラーの文言など）は文字列のまま返す
    }
    return { kind: "ok", status: res.status, body: parsed };
  };
}

export const togglClient: TogglClient = createTogglClient();

export interface TogglDeps {
  client: TogglClient;
  configPath: string;
}

// トークンの設定ファイルの場所。NOD_DOCS_DIR などと同じく環境変数で差し替えられる
export function defaultTogglConfigPath(env: Record<string, string | undefined> = process.env): string {
  return env.NOD_TOGGL_CONFIG || join(homedir(), ".config", "nod", "toggl.json");
}

// 設定ファイルのトークン。Toggl を呼ぶたびに読み、サーバーを再起動せずに書き換えを反映する。無い・読めなければ null
export function readTogglToken(configPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  try {
    const token = (JSON.parse(text) as { apiToken?: unknown } | null)?.apiToken;
    return typeof token === "string" && token.trim() !== "" ? token.trim() : null;
  } catch {
    return null;
  }
}

// Toggl の現在の打刻。thisIssue は説明が "<Issue ID> " で始まるか
export interface TogglCurrentEntry {
  id: number;
  workspaceId: number;
  description: string;
  start: string;
  thisIssue: boolean;
}

// Issue 詳細の打刻の欄が表示する状態
export interface TogglIssueView {
  configured: boolean; // トークンが設定されているか
  configPath: string; // トークンの設定ファイルの場所（未設定の案内に使う）
  current: TogglCurrentEntry | null; // 動いている打刻。無ければ null
}

// Toggl の時間記録（time entry）のうち nod が使う部分
interface TogglEntryBody {
  id: number;
  workspace_id: number;
  description: string | null;
  start: string;
}

// Toggl を呼び、2xx の本文を返す。失敗の種類の区別（認証・利用上限・通信）はまだしない
async function request(deps: TogglDeps, req: TogglRequest): Promise<unknown> {
  const res = await deps.client(req);
  if (res.kind === "ok" && res.status >= 200 && res.status < 300) return res.body;
  const detail = res.kind === "ok" ? `HTTP ${res.status}` : res.kind === "timeout" ? `${TOGGL_TIMEOUT_MS / 1000}秒以内に応答がありませんでした` : res.detail;
  throw new NodError("TOGGL_FAILED", `Toggl を呼び出せませんでした（${detail}）`);
}

// 打刻がこの Issue のものか。"NOD-6 " で始まる説明だけを NOD-6 の打刻とし、NOD-60 と取り違えない
function toCurrent(entry: TogglEntryBody, issueId: string): TogglCurrentEntry {
  const description = entry.description ?? "";
  return { id: entry.id, workspaceId: entry.workspace_id, description, start: entry.start, thisIssue: description.startsWith(`${issueId} `) };
}

interface TogglIssueTarget {
  issueId: string;
  title: string;
  token: string | null;
}

function target(db: Database, ref: string, deps: TogglDeps): TogglIssueTarget {
  const row = findIssueRow(db, ref);
  return { issueId: formatIssueId(row.ws_key, row.number), title: row.title, token: readTogglToken(deps.configPath) };
}

async function fetchCurrent(deps: TogglDeps, token: string, issueId: string): Promise<TogglCurrentEntry | null> {
  const body = (await request(deps, { method: "GET", path: "/me/time_entries/current", token })) as TogglEntryBody | null;
  return body ? toCurrent(body, issueId) : null;
}

// Issue 詳細の打刻の欄の状態。トークンが未設定なら Toggl を呼ばない
export async function getTogglState(db: Database, ref: string, deps: TogglDeps): Promise<TogglIssueView> {
  const { issueId, token } = target(db, ref, deps);
  if (token === null) return { configured: false, configPath: deps.configPath, current: null };
  return { configured: true, configPath: deps.configPath, current: await fetchCurrent(deps, token, issueId) };
}

function requireToken(t: TogglIssueTarget): string {
  if (t.token === null) throw new NodError("TOGGL_NOT_CONFIGURED", "Toggl の API トークンが設定されていません");
  return t.token;
}

// この Issue の打刻を、トークンの持ち主の既定の Workspace に開始する。説明は開始時点のタイトルで作り、あとから書き換えない。
// Project・タグは付けない
export async function startTogglEntry(db: Database, ref: string, deps: TogglDeps): Promise<TogglIssueView> {
  const t = target(db, ref, deps);
  const token = requireToken(t);
  const me = (await request(deps, { method: "GET", path: "/me", token })) as { default_workspace_id?: unknown } | null;
  const workspaceId = me?.default_workspace_id;
  if (typeof workspaceId !== "number") throw new NodError("TOGGL_FAILED", "Toggl の既定の Workspace が分かりませんでした");
  const body = { created_with: "nod", workspace_id: workspaceId, description: `${t.issueId} ${t.title}`, start: now(), duration: -1 };
  const entry = (await request(deps, { method: "POST", path: `/workspaces/${workspaceId}/time_entries`, token, body })) as TogglEntryBody;
  return { configured: true, configPath: deps.configPath, current: toCurrent(entry, t.issueId) };
}

// この Issue の打刻を止める。動いている打刻がこの Issue のものでなければ止めない
export async function stopTogglEntry(db: Database, ref: string, deps: TogglDeps): Promise<TogglIssueView> {
  const t = target(db, ref, deps);
  const token = requireToken(t);
  const current = await fetchCurrent(deps, token, t.issueId);
  if (!current?.thisIssue) throw new NodError("INVALID_STATE", `${t.issueId} の打刻は動いていません`);
  await request(deps, { method: "PATCH", path: `/workspaces/${current.workspaceId}/time_entries/${current.id}/stop`, token });
  return { configured: true, configPath: deps.configPath, current: null };
}
