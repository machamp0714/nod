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

function succeeded(res: TogglResponse): res is { kind: "ok"; status: number; body: unknown } {
  return res.kind === "ok" && res.status >= 200 && res.status < 300;
}

function failureDetail(res: TogglResponse): string {
  return res.kind === "ok" ? `HTTP ${res.status}` : res.kind === "timeout" ? `${TOGGL_TIMEOUT_MS / 1000}秒以内に応答がありませんでした` : res.detail;
}

// 書き込み（開始・停止）が Toggl に届いたか。HTTP の失敗は届いて断られた、応答が途絶えた・接続が切れたは届いたか分からない
function writeOutcome(res: TogglResponse): "failed" | "unknown" {
  return res.kind === "ok" ? "failed" : "unknown";
}

// Toggl を呼び、2xx の本文を返す。失敗の種類の区別（認証・利用上限・通信）はまだしない
async function request(deps: TogglDeps, req: TogglRequest): Promise<unknown> {
  const res = await deps.client(req);
  if (succeeded(res)) return res.body;
  throw new NodError("TOGGL_FAILED", `Toggl を呼び出せませんでした（${failureDetail(res)}）`);
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

// 止めようとした打刻が Toggl に無い・すでに止まっていた（外で止められた・消された）ときの応答。
// Toggl v9 は止まっている打刻の停止に 409、無い打刻に 404 を返すと見込む（本物の Toggl では未確認）
function isStopConflict(res: TogglResponse): boolean {
  return res.kind === "ok" && (res.status === 404 || res.status === 409);
}

// 失敗のあとに現在の打刻を取り直す。取り直しにも失敗したら null（成否を確認できない）
async function refetch(deps: TogglDeps, t: TogglIssueTarget, token: string): Promise<TogglIssueView | null> {
  try {
    return { configured: true, configPath: deps.configPath, current: await fetchCurrent(deps, token, t.issueId) };
  } catch {
    return null;
  }
}

const UNCONFIRMED = "。現在の打刻を取得できず、成否を確認できません";

// 外部との競合を検出したら、それ以上 Toggl に書き込まずに中断し、取り直した状態を返す
async function conflict(deps: TogglDeps, t: TogglIssueTarget, token: string): Promise<never> {
  const view = await refetch(deps, t, token);
  const message = `Toggl の打刻がほかで変わっていたため、操作を中断しました${view ? "。最新の状態を表示します" : UNCONFIRMED}`;
  throw new NodError("TOGGL_CONFLICT", message, { view } satisfies TogglFailureDetails);
}

// 開始・停止の失敗・競合で返す補足。view は取り直した現在の打刻（取り直せなければ null）
export interface TogglFailureDetails {
  view: TogglIssueView | null;
}
// 開始（切り替え）の失敗の補足。previous は止めようとした前の打刻（無ければ null）と、それが止まったか。
// start は新しい打刻の成否（not_attempted は前の打刻を止められず開始しなかった）
export interface TogglStartFailureDetails extends TogglFailureDetails {
  previous: { description: string; stopped: true | false | "unknown" } | null;
  start: "failed" | "unknown" | "not_attempted";
}

async function startFailed(
  deps: TogglDeps,
  t: TogglIssueTarget,
  token: string,
  previous: TogglStartFailureDetails["previous"],
  start: TogglStartFailureDetails["start"],
  res: TogglResponse,
): Promise<never> {
  const view = await refetch(deps, t, token);
  const detail = failureDetail(res);
  const parts: string[] = [];
  if (previous?.stopped === true) parts.push(`前の打刻「${previous.description}」は止まりました`);
  if (previous?.stopped === false) parts.push(`前の打刻「${previous.description}」を止められませんでした（${detail}）`);
  if (previous?.stopped === "unknown") parts.push(`前の打刻「${previous.description}」が止まったかは分かりません（${detail}）`);
  if (start === "failed") parts.push(`この Issue の打刻は開始できませんでした（${detail}）`);
  if (start === "unknown") parts.push(`この Issue の打刻が開始されたかは分かりません（${detail}）`);
  if (start === "not_attempted") parts.push("この Issue の打刻は開始していません");
  const details: TogglStartFailureDetails = { previous, start, view };
  throw new NodError("TOGGL_START_FAILED", `${parts.join("。")}${view ? "" : UNCONFIRMED}`, details);
}

// この Issue の打刻を、トークンの持ち主の既定の Workspace に開始する。説明は開始時点のタイトルで作り、あとから書き換えない。
// Project・タグは付けない。開始の直前に現在の打刻を取り直し、別の打刻が動いていれば明示的に止めてから開始する
// （duration=-1 での開始が既存の打刻を自動で止めるかは未確認のため、それに頼らない）。
// 途中で失敗しても再送せず、取り直した状態と、前の打刻・新しい打刻それぞれの成否を返す
export async function startTogglEntry(db: Database, ref: string, deps: TogglDeps): Promise<TogglIssueView> {
  const t = target(db, ref, deps);
  const token = requireToken(t);
  const current = await fetchCurrent(deps, token, t.issueId);
  // この Issue の打刻がすでに動いていれば、二重に作らない
  if (current?.thisIssue) return { configured: true, configPath: deps.configPath, current };
  const me = (await request(deps, { method: "GET", path: "/me", token })) as { default_workspace_id?: unknown } | null;
  const workspaceId = me?.default_workspace_id;
  if (typeof workspaceId !== "number") throw new NodError("TOGGL_FAILED", "Toggl の既定の Workspace が分かりませんでした");
  let previous: TogglStartFailureDetails["previous"] = null;
  if (current) {
    const stop = await deps.client({ method: "PATCH", path: `/workspaces/${current.workspaceId}/time_entries/${current.id}/stop`, token });
    if (isStopConflict(stop)) return conflict(deps, t, token);
    if (!succeeded(stop)) {
      const stopped = writeOutcome(stop) === "failed" ? false : "unknown";
      return startFailed(deps, t, token, { description: current.description, stopped }, "not_attempted", stop);
    }
    previous = { description: current.description, stopped: true };
  }
  const body = { created_with: "nod", workspace_id: workspaceId, description: `${t.issueId} ${t.title}`, start: now(), duration: -1 };
  const created = await deps.client({ method: "POST", path: `/workspaces/${workspaceId}/time_entries`, token, body });
  if (!succeeded(created)) return startFailed(deps, t, token, previous, writeOutcome(created), created);
  return { configured: true, configPath: deps.configPath, current: toCurrent(created.body as TogglEntryBody, t.issueId) };
}

// この Issue の打刻を止める。動いている打刻がこの Issue のものでなければ止めない。
// 止めようとした打刻がすでに止まっていた・無かったら、競合として取り直した状態を返す
export async function stopTogglEntry(db: Database, ref: string, deps: TogglDeps): Promise<TogglIssueView> {
  const t = target(db, ref, deps);
  const token = requireToken(t);
  const current = await fetchCurrent(deps, token, t.issueId);
  if (!current?.thisIssue) throw new NodError("INVALID_STATE", `${t.issueId} の打刻は動いていません`);
  const res = await deps.client({ method: "PATCH", path: `/workspaces/${current.workspaceId}/time_entries/${current.id}/stop`, token });
  if (isStopConflict(res)) return conflict(deps, t, token);
  if (!succeeded(res)) throw new NodError("TOGGL_FAILED", `Toggl を呼び出せませんでした（${failureDetail(res)}）`);
  return { configured: true, configPath: deps.configPath, current: null };
}

// nod 内の開始・停止を 1 つずつ処理する。2 つのタブからの同時の操作が、取り直しと書き込みの間に割り込まないようにする
export function createTogglSerializer(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}
