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
// Toggl の API の応答。HTTP の失敗（4xx・5xx）も ok で返し、状態コードで区別する。
// headers は利用上限の待ち時間を決めるヘッダ（小文字の名前）だけを持つ
export type TogglResponse =
  | { kind: "ok"; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: "network_error"; detail: string } // 接続できない
  | { kind: "timeout" }; // 時間切れで止めた
// Toggl の API を呼ぶ部分。テストと e2e は偽のクライアントを渡し、本物の Toggl には触れない
export type TogglClient = (req: TogglRequest) => Promise<TogglResponse>;

export const TOGGL_API_BASE = "https://api.track.toggl.com/api/v9";
export const TOGGL_TIMEOUT_MS = 15_000;
// 利用上限（402・429）の応答で、次に呼べるまでの秒数を表すヘッダ。X-Toggl-Quota-Resets-In は Toggl の文書の記述
// （利用枠の窓が戻るまでの秒数）、Retry-After は 429 の一般的なヘッダ（秒数か HTTP の日付）
const QUOTA_HEADERS = ["x-toggl-quota-resets-in", "retry-after"] as const;
// 利用上限の応答に待ち時間のヘッダが無いときに待つ時間。Toggl の 429 は秒単位の流量制限なので短く、
// 402（毎時の利用枠）でも 1 分ごとに 1 回試すだけなら利用枠をほとんど使わない
export const TOGGL_QUOTA_FALLBACK_MS = 60_000;

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
    const quotaHeaders: Record<string, string> = {};
    for (const name of QUOTA_HEADERS) {
      const value = res.headers.get(name);
      if (value !== null) quotaHeaders[name] = value;
    }
    return { kind: "ok", status: res.status, body: parsed, headers: quotaHeaders };
  };
}

export const togglClient: TogglClient = createTogglClient();

export interface TogglDeps {
  client: TogglClient;
  configPath: string;
  cache: TogglCache;
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

// Toggl の動いている打刻そのもの（Issue に依存しない）
export interface TogglEntry {
  id: number;
  workspaceId: number;
  description: string;
  start: string;
}

// Toggl の現在の打刻。thisIssue は説明が "<Issue ID> " で始まるか
export interface TogglCurrentEntry extends TogglEntry {
  thisIssue: boolean;
}

// Toggl を呼べなかった理由。auth は認証の失敗（401・403。トークンを直す）、quota は利用上限（402・429。retryAfter まで待つ）、
// network はそのほかの失敗（接続できない・応答が途絶えた・5xx など。やり直す）
export interface TogglFailure {
  kind: "auth" | "quota" | "network";
  detail: string;
  retryAfter?: string; // quota のとき、この時刻まで Toggl を呼ばない
}

// Issue 詳細の打刻の欄が表示する状態
export interface TogglIssueView {
  configured: boolean; // トークンが設定されているか
  configPath: string; // トークンの設定ファイルの場所（未設定の案内に使う）
  current: TogglCurrentEntry | null; // 最後に分かっている動いている打刻。無ければ null
  fetchedAt: string | null; // current が Toggl で分かった時刻。未設定・一度も取得できていなければ null
  failure: TogglFailure | null; // 直近の Toggl の呼び出しの失敗。current は最後に分かっている状態のまま
  unconfirmed: boolean; // 開始・停止の成否を確認できていない。取り直せるまで開始・停止させない
}

export const TOGGL_CACHE_TTL_MS = 5 * 60_000;

// Toggl の現在の打刻を、取得したトークンと時刻とともに持つ
export interface TogglSnapshot {
  token: string;
  entry: TogglEntry | null;
  fetchedAt: number; // epoch ミリ秒
}

// 現在の打刻のキャッシュ。サーバーのメモリに 1 つだけ持ち、すべての Issue・タブで共有する（Toggl の現在の打刻の取得は毎時 30 回まで）。
// 期限が切れても最後に分かっている打刻は残す（停止は期限切れでもこの打刻 ID で行う）。
// 利用上限の待ち（quota）と、開始・停止の成否を確認できていないこと（unconfirmed）も持つ。トークンが変わったら捨てる
export interface TogglCache {
  now: () => number; // epoch ミリ秒。テストは時計を差し替える
  ttlMs: number;
  get(token: string): TogglSnapshot | null; // 最後に分かっている現在の打刻（期限切れも返す）
  // 現在の打刻を入れ、unconfirmed を解く。since は取得を始めたときの generation()。
  // その後に開始・停止の結果（since なしの set）や成否不明が入っていたら、遅れて届いた取得の結果で上書きせず、今の内容を返す
  set(token: string, entry: TogglEntry | null, since?: number): TogglSnapshot;
  generation(): number;
  quota(token: string): TogglFailure | null; // 利用上限の待ち。待ち終わっていれば null
  setQuota(token: string, failure: TogglFailure): void;
  unconfirmed(token: string): boolean;
  setUnconfirmed(token: string): void;
  clear(): void;
}

export function createTogglCache(opts: { now?: () => number; ttlMs?: number } = {}): TogglCache {
  let state: { token: string; snapshot: TogglSnapshot | null; quota: TogglFailure | null; unconfirmed: boolean } | null = null;
  let generation = 0;
  const now = opts.now ?? Date.now;
  const of = (token: string) => {
    if (state?.token !== token) state = { token, snapshot: null, quota: null, unconfirmed: false };
    return state;
  };
  return {
    now,
    ttlMs: opts.ttlMs ?? TOGGL_CACHE_TTL_MS,
    get(token) {
      return of(token).snapshot;
    },
    set(token, entry, since) {
      const s = of(token);
      if (since !== undefined && since !== generation && s.snapshot) return s.snapshot;
      if (since === undefined) generation++;
      s.snapshot = { token, entry, fetchedAt: now() };
      s.unconfirmed = false;
      return s.snapshot;
    },
    generation: () => generation,
    quota(token) {
      const s = of(token);
      if (s.quota && Date.parse(s.quota.retryAfter ?? "") <= now()) s.quota = null;
      return s.quota;
    },
    setQuota(token, failure) {
      of(token).quota = failure;
    },
    unconfirmed: (token) => of(token).unconfirmed,
    setUnconfirmed(token) {
      // 遅れて届いた取得の結果（操作の前の状態）で、成否不明を解かないようにする
      generation++;
      of(token).unconfirmed = true;
    },
    clear() {
      state = null;
    },
  };
}

function isFresh(cache: TogglCache, snapshot: TogglSnapshot): boolean {
  return cache.now() - snapshot.fetchedAt < cache.ttlMs;
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

// 利用上限の応答で次に呼べるまでの時間。X-Toggl-Quota-Resets-In（秒）、Retry-After（秒か HTTP の日付）の順に見て、無ければ既定の時間
function quotaWaitMs(deps: TogglDeps, headers: Record<string, string> = {}): number {
  const resetsIn = Number(headers["x-toggl-quota-resets-in"]);
  if (headers["x-toggl-quota-resets-in"] && Number.isFinite(resetsIn) && resetsIn >= 0) return resetsIn * 1000;
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - deps.cache.now());
  }
  return TOGGL_QUOTA_FALLBACK_MS;
}

function failureOf(deps: TogglDeps, res: TogglResponse): TogglFailure {
  const detail = failureDetail(res);
  if (res.kind === "ok" && (res.status === 401 || res.status === 403)) return { kind: "auth", detail };
  if (res.kind === "ok" && (res.status === 402 || res.status === 429)) {
    return { kind: "quota", detail, retryAfter: new Date(deps.cache.now() + quotaWaitMs(deps, res.headers)).toISOString() };
  }
  return { kind: "network", detail };
}

// Toggl の呼び出しの失敗。request が投げ、取得は表示に、開始・停止は NodError に変える
class TogglCallError extends Error {
  constructor(readonly failure: TogglFailure) {
    super(failure.detail);
  }
}

// Toggl を呼ぶ。利用上限の応答なら待ちをキャッシュに入れ、待ち終わるまでどの呼び出しも Toggl に送らない
async function send(deps: TogglDeps, req: TogglRequest): Promise<TogglResponse> {
  const res = await deps.client(req);
  if (res.kind === "ok" && (res.status === 402 || res.status === 429)) deps.cache.setQuota(req.token, failureOf(deps, res));
  return res;
}

// Toggl を呼び、2xx の本文を返す。失敗なら種類（認証・利用上限・通信）を TogglCallError で投げる
async function request(deps: TogglDeps, req: TogglRequest): Promise<unknown> {
  const quota = deps.cache.quota(req.token);
  if (quota) throw new TogglCallError(quota);
  const res = await send(deps, req);
  if (succeeded(res)) return res.body;
  throw new TogglCallError(failureOf(deps, res));
}

function toEntry(body: TogglEntryBody): TogglEntry {
  return { id: body.id, workspaceId: body.workspace_id, description: body.description ?? "", start: body.start };
}

// 打刻がこの Issue のものか。"NOD-6 " で始まる説明だけを NOD-6 の打刻とし、NOD-60 と取り違えない
function toCurrent(entry: TogglEntry | null, issueId: string): TogglCurrentEntry | null {
  return entry ? { ...entry, thisIssue: entry.description.startsWith(`${issueId} `) } : null;
}

// snapshot は最後に分かっている現在の打刻（一度も取得できていなければ null）。failure は直近の呼び出しの失敗
function viewOf(deps: TogglDeps, token: string, snapshot: TogglSnapshot | null, issueId: string, failure: TogglFailure | null = null): TogglIssueView {
  return {
    configured: true,
    configPath: deps.configPath,
    current: toCurrent(snapshot?.entry ?? null, issueId),
    fetchedAt: snapshot ? new Date(snapshot.fetchedAt).toISOString() : null,
    failure,
    unconfirmed: deps.cache.unconfirmed(token),
  };
}

function unconfiguredView(deps: TogglDeps): TogglIssueView {
  return { configured: false, configPath: deps.configPath, current: null, fetchedAt: null, failure: null, unconfirmed: false };
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

// Toggl から現在の打刻を取り直し、キャッシュに入れる。取得の間に開始・停止の結果が入っていたら、そちらを返す
async function fetchCurrent(deps: TogglDeps, token: string): Promise<TogglSnapshot> {
  const since = deps.cache.generation();
  const body = (await request(deps, { method: "GET", path: "/me/time_entries/current", token })) as TogglEntryBody | null;
  return deps.cache.set(token, body ? toEntry(body) : null, since);
}

// 取り直した状態。失敗したら最後に分かっている状態と失敗の理由を返す（初めての取得の失敗なら current も fetchedAt も null）
async function fetchView(deps: TogglDeps, token: string, issueId: string): Promise<TogglIssueView> {
  try {
    return viewOf(deps, token, await fetchCurrent(deps, token), issueId);
  } catch (e) {
    if (!(e instanceof TogglCallError)) throw e;
    return viewOf(deps, token, deps.cache.get(token), issueId, e.failure);
  }
}

// Issue 詳細の打刻の欄の状態。期限内ならキャッシュを返し、Toggl を呼ばない。トークンが未設定なら Toggl を呼ばない。
// 開始・停止の成否を確認できていなければ期限内でも取り直す。Toggl を呼べなければ 200 で失敗の理由を添えて返す。
// 利用上限を待っている間は Toggl を呼ばない
export async function getTogglState(db: Database, ref: string, deps: TogglDeps): Promise<TogglIssueView> {
  const { issueId, token } = target(db, ref, deps);
  if (token === null) return unconfiguredView(deps);
  const cached = deps.cache.get(token);
  // 利用上限を待っている間は、期限内のキャッシュでも待っていることを添える（開始・停止のボタンを無効にする）
  const quota = deps.cache.quota(token);
  if (quota) return viewOf(deps, token, cached, issueId, quota);
  if (cached && isFresh(deps.cache, cached) && !deps.cache.unconfirmed(token)) return viewOf(deps, token, cached, issueId);
  return fetchView(deps, token, issueId);
}

// 「最新にする」。キャッシュを無視して現在の打刻を取り直す（利用上限を待っている間は Toggl を呼ばない）
export async function refreshTogglState(db: Database, ref: string, deps: TogglDeps): Promise<TogglIssueView> {
  const { issueId, token } = target(db, ref, deps);
  if (token === null) return unconfiguredView(deps);
  return fetchView(deps, token, issueId);
}

const FAILURE_CODES: Record<TogglFailure["kind"], string> = { auth: "TOGGL_AUTH", quota: "TOGGL_QUOTA", network: "TOGGL_FAILED" };

function failureMessage(f: TogglFailure): string {
  if (f.kind === "auth") return `Toggl の API トークンが受け付けられませんでした（${f.detail}）`;
  if (f.kind === "quota") return `Toggl の利用上限に達しました（${f.detail}）`;
  return `Toggl を呼び出せませんでした（${f.detail}）`;
}

// 書き込む前の失敗（取り直し・既定の Workspace の取得・利用上限の待ち）。Toggl は変えていないので、最後に分かっている状態と理由を返す
function beforeWrite(deps: TogglDeps, t: TogglIssueTarget, token: string, e: unknown): never {
  if (!(e instanceof TogglCallError)) throw e;
  const view = viewOf(deps, token, deps.cache.get(token), t.issueId, e.failure);
  throw new NodError(FAILURE_CODES[e.failure.kind]!, failureMessage(e.failure), { view } satisfies TogglFailureDetails);
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

// 失敗のあとに現在の打刻を取り直す。取り直しにも失敗したら、成否を確認できないことを記録し（取り直せるまで開始・停止させない）、
// 最後に分かっている状態と取り直しの失敗の理由を返す。ただし書き込みが利用上限で断られたときは、取り直さなくても状態は変わっていない
// （前の打刻を止めたことはキャッシュに入れてある）ので、成否不明にしない
async function refetch(deps: TogglDeps, t: TogglIssueTarget, token: string, write?: TogglResponse): Promise<TogglIssueView> {
  try {
    return viewOf(deps, token, await fetchCurrent(deps, token), t.issueId);
  } catch (e) {
    if (!(e instanceof TogglCallError)) throw e;
    const refused = write !== undefined && writeOutcome(write) === "failed" && failureOf(deps, write).kind === "quota";
    if (!refused) deps.cache.setUnconfirmed(token);
    return viewOf(deps, token, deps.cache.get(token), t.issueId, e.failure);
  }
}

const UNCONFIRMED = "。現在の打刻を取得できず、成否を確認できません";

// 外部との競合を検出したら、それ以上 Toggl に書き込まずに中断し、取り直した状態を返す
async function conflict(deps: TogglDeps, t: TogglIssueTarget, token: string): Promise<never> {
  const view = await refetch(deps, t, token);
  const message = `Toggl の打刻がほかで変わっていたため、操作を中断しました${view.unconfirmed ? UNCONFIRMED : "。最新の状態を表示します"}`;
  throw new NodError("TOGGL_CONFLICT", message, { view } satisfies TogglFailureDetails);
}

// 開始・停止の失敗・競合で返す補足。view は取り直した現在の打刻（取り直せなければ最後に分かっている状態と unconfirmed: true）
export interface TogglFailureDetails {
  view: TogglIssueView;
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
  const view = await refetch(deps, t, token, res);
  const detail = failureDetail(res);
  const parts: string[] = [];
  if (previous?.stopped === true) parts.push(`前の打刻「${previous.description}」は止まりました`);
  if (previous?.stopped === false) parts.push(`前の打刻「${previous.description}」を止められませんでした（${detail}）`);
  if (previous?.stopped === "unknown") parts.push(`前の打刻「${previous.description}」が止まったかは分かりません（${detail}）`);
  if (start === "failed") parts.push(`この Issue の打刻は開始できませんでした（${detail}）`);
  if (start === "unknown") parts.push(`この Issue の打刻が開始されたかは分かりません（${detail}）`);
  if (start === "not_attempted") parts.push("この Issue の打刻は開始していません");
  const details: TogglStartFailureDetails = { previous, start, view };
  throw new NodError("TOGGL_START_FAILED", `${parts.join("。")}${view.unconfirmed ? UNCONFIRMED : ""}`, details);
}

// この Issue の打刻を、トークンの持ち主の既定の Workspace に開始する。説明は開始時点のタイトルで作り、あとから書き換えない。
// Project・タグは付けない。開始の直前に現在の打刻を取り直し、別の打刻が動いていれば明示的に止めてから開始する
// （duration=-1 での開始が既存の打刻を自動で止めるかは未確認のため、それに頼らない）。
// 途中で失敗しても再送せず、取り直した状態と、前の打刻・新しい打刻それぞれの成否を返す
export async function startTogglEntry(db: Database, ref: string, deps: TogglDeps): Promise<TogglIssueView> {
  const t = target(db, ref, deps);
  const token = requireToken(t);
  let fetched: TogglSnapshot;
  let me: { default_workspace_id?: unknown } | null;
  try {
    fetched = await fetchCurrent(deps, token);
    // この Issue の打刻がすでに動いていれば、二重に作らない
    if (toCurrent(fetched.entry, t.issueId)?.thisIssue) return viewOf(deps, token, fetched, t.issueId);
    me = (await request(deps, { method: "GET", path: "/me", token })) as typeof me;
  } catch (e) {
    return beforeWrite(deps, t, token, e);
  }
  const current = toCurrent(fetched.entry, t.issueId);
  const workspaceId = me?.default_workspace_id;
  if (typeof workspaceId !== "number") throw new NodError("TOGGL_FAILED", "Toggl の既定の Workspace が分かりませんでした");
  let previous: TogglStartFailureDetails["previous"] = null;
  if (current) {
    const stop = await send(deps, { method: "PATCH", path: `/workspaces/${current.workspaceId}/time_entries/${current.id}/stop`, token });
    if (isStopConflict(stop)) return conflict(deps, t, token);
    if (!succeeded(stop)) {
      const stopped = writeOutcome(stop) === "failed" ? false : "unknown";
      return startFailed(deps, t, token, { description: current.description, stopped }, "not_attempted", stop);
    }
    // 前の打刻は止まった。この先で失敗して取り直せなくても、止まったことはキャッシュに残す
    deps.cache.set(token, null);
    previous = { description: current.description, stopped: true };
  }
  const body = { created_with: "nod", workspace_id: workspaceId, description: `${t.issueId} ${t.title}`, start: now(), duration: -1 };
  const created = await send(deps, { method: "POST", path: `/workspaces/${workspaceId}/time_entries`, token, body });
  if (!succeeded(created)) return startFailed(deps, t, token, previous, writeOutcome(created), created);
  return viewOf(deps, token, deps.cache.set(token, toEntry(created.body as TogglEntryBody)), t.issueId);
}

// この Issue の打刻を、キャッシュの打刻 ID で止める（期限切れでも使う。キャッシュが無い・成否を確認できていなければ取得する）。
// 動いている打刻がこの Issue のものでなければ止めない。止めようとした打刻がすでに止まっていた・無かったら、
// 競合として取り直した状態を返す。そのほかの失敗でも再送せずに取り直し、その状態を返す
export async function stopTogglEntry(db: Database, ref: string, deps: TogglDeps): Promise<TogglIssueView> {
  const t = target(db, ref, deps);
  const token = requireToken(t);
  let snapshot: TogglSnapshot;
  try {
    const quota = deps.cache.quota(token);
    if (quota) throw new TogglCallError(quota);
    const cached = deps.cache.get(token);
    snapshot = cached && !deps.cache.unconfirmed(token) ? cached : await fetchCurrent(deps, token);
  } catch (e) {
    return beforeWrite(deps, t, token, e);
  }
  const current = toCurrent(snapshot.entry, t.issueId);
  if (!current?.thisIssue) throw new NodError("INVALID_STATE", `${t.issueId} の打刻は動いていません`);
  const res = await send(deps, { method: "PATCH", path: `/workspaces/${current.workspaceId}/time_entries/${current.id}/stop`, token });
  if (isStopConflict(res)) return conflict(deps, t, token);
  if (!succeeded(res)) {
    const view = await refetch(deps, t, token, res);
    const detail = failureDetail(res);
    const message = writeOutcome(res) === "failed" ? `打刻を停止できませんでした（${detail}）` : `打刻が止まったかは分かりません（${detail}）`;
    throw new NodError("TOGGL_FAILED", `${message}${view.unconfirmed ? UNCONFIRMED : ""}`, { view } satisfies TogglFailureDetails);
  }
  return viewOf(deps, token, deps.cache.set(token, null), t.issueId);
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
