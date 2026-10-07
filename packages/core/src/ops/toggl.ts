import type { Database } from "bun:sqlite";
import { now } from "../ctx";
import { NodError } from "../errors";
import { findIssueRow, formatIssueId } from "../issue-query";
import type { TogglCache, TogglProjectsSnapshot, TogglSnapshot } from "./toggl-cache";
import { readTogglToken, TOGGL_QUOTA_FALLBACK_MS, TOGGL_TIMEOUT_MS, type TogglClient, type TogglRequest, type TogglResponse } from "./toggl-client";

// Toggl Track の打刻（NOD-6）。nod のサーバーが Toggl の API を呼び、トークンはブラウザに渡さない。
// 打刻の状態は DB に保存しない。Toggl の API のクライアントと設定ファイルは toggl-client.ts、キャッシュは toggl-cache.ts

export interface TogglDeps {
  client: TogglClient;
  configPath: string;
  cache: TogglCache;
}

// Toggl の動いている打刻そのもの（Issue に依存しない）
export interface TogglEntry {
  id: number;
  workspaceId: number;
  projectId: number | null; // Toggl の Project。無ければ null
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

// Toggl の Project（既定の Workspace の有効なもの）
export interface TogglProject {
  id: number;
  name: string;
  color: string;
}

// 打刻の欄の Project の選択欄が表示する一覧
export interface TogglProjectsView {
  configured: boolean; // トークンが設定されているか
  projects: TogglProject[] | null; // 最後に分かっている一覧。一度も取得できていなければ null
  fetchedAt: string | null; // projects が Toggl で分かった時刻
  failure: TogglFailure | null; // 直近の Toggl の呼び出しの失敗。projects は最後に分かっている一覧のまま
}

function isFresh(cache: TogglCache, snapshot: TogglSnapshot): boolean {
  return cache.now() - snapshot.fetchedAt < cache.ttlMs;
}

// Toggl の時間記録（time entry）のうち nod が使う部分
interface TogglEntryBody {
  id: number;
  workspace_id: number;
  project_id?: number | null;
  description: string | null;
  start: string;
  duration?: number; // 動いている打刻は負の数
}

// Toggl の応答の分類。状態コードの判定はここだけで行う。
// ok は 2xx、auth は認証の失敗（401・403）、quota は利用上限（402・429）、gone は止めようとした打刻が無い・すでに止まっていた
// （Toggl v9 は止まっている打刻の停止に 409、無い打刻に 404 を返すと見込む。本物の Toggl では未確認）、rejected はそのほかの
// HTTP の失敗（届いて断られた）、no_response は応答が途絶えた・接続できない（書き込みなら届いたか分からない）
type TogglOutcome = "ok" | "auth" | "quota" | "gone" | "rejected" | "no_response";

function outcomeOf(res: TogglResponse): TogglOutcome {
  if (res.kind !== "ok") return "no_response";
  if (res.status >= 200 && res.status < 300) return "ok";
  if (res.status === 401 || res.status === 403) return "auth";
  if (res.status === 402 || res.status === 429) return "quota";
  if (res.status === 404 || res.status === 409) return "gone";
  return "rejected";
}

function succeeded(res: TogglResponse): res is { kind: "ok"; status: number; body: unknown } {
  return outcomeOf(res) === "ok";
}

function failureDetail(res: TogglResponse): string {
  return res.kind === "ok" ? `HTTP ${res.status}` : res.kind === "timeout" ? `${TOGGL_TIMEOUT_MS / 1000}秒以内に応答がありませんでした` : res.detail;
}

// 書き込み（開始・停止）が Toggl に届いたか。HTTP の失敗は届いて断られた、応答が途絶えた・接続が切れたは届いたか分からない
function writeOutcome(res: TogglResponse): "failed" | "unknown" {
  return outcomeOf(res) === "no_response" ? "unknown" : "failed";
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

// 成功しなかった応答を、表示する失敗の種類（認証・利用上限・通信）に変える
function failureOf(deps: TogglDeps, res: TogglResponse): TogglFailure {
  const detail = failureDetail(res);
  const outcome = outcomeOf(res);
  if (outcome === "auth") return { kind: "auth", detail };
  if (outcome === "quota") {
    const headers = res.kind === "ok" ? res.headers : undefined;
    return { kind: "quota", detail, retryAfter: new Date(deps.cache.now() + quotaWaitMs(deps, headers)).toISOString() };
  }
  return { kind: "network", detail };
}

// Toggl の呼び出しの失敗。readToggl が投げ、取得は表示に、開始・停止は NodError に変える
class TogglCallError extends Error {
  constructor(readonly failure: TogglFailure) {
    super(failure.detail);
  }
}

// Toggl を呼ぶときのトークン。操作の初めに設定ファイルから 1 度だけ読み、停止→開始の一連の操作で同じものを使う
interface TogglAuth {
  deps: TogglDeps;
  token: string;
}

// 1 回の操作の対象の Issue とトークン
interface TogglSession extends TogglAuth {
  issueId: string;
  title: string;
}

// Issue と設定ファイルのトークンを読む。トークンが未設定なら null
function openSession(db: Database, ref: string, deps: TogglDeps): TogglSession | null {
  const row = findIssueRow(db, ref);
  const token = readTogglToken(deps.configPath);
  return token === null ? null : { deps, issueId: formatIssueId(row.ws_key, row.number), title: row.title, token };
}

// 開始・停止の対象。トークンが未設定なら Toggl を呼ばずに断る
function requireSession(db: Database, ref: string, deps: TogglDeps): TogglSession {
  const session = openSession(db, ref, deps);
  if (session === null) throw new NodError("TOGGL_NOT_CONFIGURED", "Toggl の API トークンが設定されていません");
  return session;
}

// Toggl を呼ぶ。利用上限の応答なら待ちをキャッシュに入れ、待ち終わるまでどの呼び出しも Toggl に送らない。
// 認証の失敗もキャッシュに入れ、同じトークンのままでは表示のたびに呼ばない。2xx が返ればトークンは通るので、認証の失敗を消す
async function callToggl(session: TogglAuth, req: Omit<TogglRequest, "token">): Promise<TogglResponse> {
  const { deps, token } = session;
  const res = await deps.client({ ...req, token });
  const outcome = outcomeOf(res);
  if (outcome === "quota") deps.cache.setQuota(token, failureOf(deps, res));
  if (outcome === "auth") deps.cache.setAuthFailure(token, failureOf(deps, res));
  if (outcome === "ok") deps.cache.setAuthFailure(token, null);
  return res;
}

// Toggl から読み、2xx の本文を返す。利用上限を待っている間は呼ばない。失敗なら種類（認証・利用上限・通信）を TogglCallError で投げる
async function readToggl(session: TogglAuth, path: string): Promise<unknown> {
  const quota = session.deps.cache.quota(session.token);
  if (quota) throw new TogglCallError(quota);
  const res = await callToggl(session, { method: "GET", path });
  if (succeeded(res)) return res.body;
  throw new TogglCallError(failureOf(session.deps, res));
}

// Toggl を呼ばずに断る理由。利用上限を待っている間か、同じトークンで認証に失敗したあと
function blockedBy(session: TogglAuth): TogglFailure | null {
  const { cache } = session.deps;
  return cache.quota(session.token) ?? cache.authFailure(session.token);
}

function toEntry(body: TogglEntryBody): TogglEntry {
  return { id: body.id, workspaceId: body.workspace_id, projectId: body.project_id ?? null, description: body.description ?? "", start: body.start };
}

// 打刻がこの Issue のものか。"NOD-6 " で始まる説明だけを NOD-6 の打刻とし、NOD-60 と取り違えない
function toCurrent(entry: TogglEntry | null, issueId: string): TogglCurrentEntry | null {
  return entry ? { ...entry, thisIssue: entry.description.startsWith(`${issueId} `) } : null;
}

// snapshot は最後に分かっている現在の打刻（一度も取得できていなければ null）。failure は直近の呼び出しの失敗
function viewOf(session: TogglSession, snapshot: TogglSnapshot | null, failure: TogglFailure | null = null): TogglIssueView {
  return {
    configured: true,
    configPath: session.deps.configPath,
    current: toCurrent(snapshot?.entry ?? null, session.issueId),
    fetchedAt: snapshot ? new Date(snapshot.fetchedAt).toISOString() : null,
    failure,
    unconfirmed: session.deps.cache.unconfirmed(session.token),
  };
}

// 最後に分かっている状態と、直近の呼び出しの失敗
function lastKnownView(session: TogglSession, failure: TogglFailure | null = null): TogglIssueView {
  return viewOf(session, session.deps.cache.get(session.token), failure);
}

function unconfiguredView(deps: TogglDeps): TogglIssueView {
  return { configured: false, configPath: deps.configPath, current: null, fetchedAt: null, failure: null, unconfirmed: false };
}

// Toggl から現在の打刻を取り直し、キャッシュに入れる。取得の間に開始・停止の結果が入っていたら、そちらを返す
async function fetchCurrent(session: TogglSession): Promise<TogglSnapshot> {
  const { cache } = session.deps;
  const fetchStartedAt = cache.generation();
  const body = (await readToggl(session, "/me/time_entries/current")) as TogglEntryBody | null;
  return cache.set(session.token, body ? toEntry(body) : null, fetchStartedAt);
}

// 取り直した状態。失敗したら最後に分かっている状態と失敗の理由を返す（初めての取得の失敗なら current も fetchedAt も null）
async function fetchView(session: TogglSession): Promise<TogglIssueView> {
  try {
    return viewOf(session, await fetchCurrent(session));
  } catch (e) {
    if (!(e instanceof TogglCallError)) throw e;
    return lastKnownView(session, e.failure);
  }
}

// Issue 詳細の打刻の欄の状態。期限内ならキャッシュを返し、Toggl を呼ばない。トークンが未設定なら Toggl を呼ばない。
// 開始・停止の成否を確認できていなければ期限内でも取り直す。Toggl を呼べなければ 200 で失敗の理由を添えて返す。
// 利用上限を待っている間と、同じトークンで認証に失敗したあとは Toggl を呼ばない
export async function getTogglState(db: Database, ref: string, deps: TogglDeps): Promise<TogglIssueView> {
  const session = openSession(db, ref, deps);
  if (session === null) return unconfiguredView(deps);
  const cached = deps.cache.get(session.token);
  // 利用上限の待ち・認証の失敗は、期限内のキャッシュでも添える（開始・停止のボタンを無効にする）
  const blocked = blockedBy(session);
  if (blocked) return viewOf(session, cached, blocked);
  if (cached && isFresh(deps.cache, cached) && !deps.cache.unconfirmed(session.token)) return viewOf(session, cached);
  return fetchView(session);
}

// 「最新にする」。キャッシュを無視して現在の打刻を取り直す（認証の失敗を覚えていても取り直す。利用上限を待っている間は Toggl を呼ばない）
export async function refreshTogglState(db: Database, ref: string, deps: TogglDeps): Promise<TogglIssueView> {
  const session = openSession(db, ref, deps);
  if (session === null) return unconfiguredView(deps);
  return fetchView(session);
}

const FAILURE_CODES: Record<TogglFailure["kind"], string> = { auth: "TOGGL_AUTH", quota: "TOGGL_QUOTA", network: "TOGGL_FAILED" };

function failureMessage(f: TogglFailure): string {
  if (f.kind === "auth") return `Toggl の API トークンが受け付けられませんでした（${f.detail}）`;
  if (f.kind === "quota") return `Toggl の利用上限に達しました（${f.detail}）`;
  return `Toggl を呼び出せませんでした（${f.detail}）`;
}

// 書き込む前の失敗（取り直し・既定の Workspace の取得・利用上限の待ち・覚えている認証の失敗）。Toggl は変えていないので、最後に分かっている状態と理由を返す
function failBeforeWrite(session: TogglSession, e: unknown): never {
  if (!(e instanceof TogglCallError)) throw e;
  const view = lastKnownView(session, e.failure);
  throw new NodError(FAILURE_CODES[e.failure.kind]!, failureMessage(e.failure), { view } satisfies TogglFailureDetails);
}

// 打刻を止める（PATCH .../stop）。応答は呼び出し側が分類する
function stopEntry(session: TogglSession, entry: TogglEntry): Promise<TogglResponse> {
  return callToggl(session, { method: "PATCH", path: `/workspaces/${entry.workspaceId}/time_entries/${entry.id}/stop` });
}

// 失敗のあとに現在の打刻を取り直す。取り直しにも失敗したら、成否を確認できないことを記録し（取り直せるまで開始・停止させない）、
// 最後に分かっている状態と取り直しの失敗の理由を返す。ただし書き込みが利用上限で断られたときは、取り直さなくても状態は変わっていない
// （前の打刻を止めたことはキャッシュに入れてある）ので、成否不明にしない
async function refetchAfterFailure(session: TogglSession, write?: TogglResponse): Promise<TogglIssueView> {
  try {
    return viewOf(session, await fetchCurrent(session));
  } catch (e) {
    if (!(e instanceof TogglCallError)) throw e;
    const refusedByQuota = write !== undefined && outcomeOf(write) === "quota";
    if (!refusedByQuota) session.deps.cache.setUnconfirmed(session.token);
    return lastKnownView(session, e.failure);
  }
}

// 取り直しにも失敗したときに、失敗の文言に添える
const UNCONFIRMED_SUFFIX = "。現在の打刻を取得できず、成否を確認できません";

// 外部との競合を検出したら、それ以上 Toggl に書き込まずに中断し、取り直した状態を返す。reason は競合で起きたことの文言（省けば中断したことだけ）
async function abortOnConflict(session: TogglSession, reason = "Toggl の打刻がほかで変わっていたため、操作を中断しました"): Promise<never> {
  const view = await refetchAfterFailure(session);
  const message = `${reason}${view.unconfirmed ? UNCONFIRMED_SUFFIX : "。最新の状態を表示します"}`;
  throw new NodError("TOGGL_CONFLICT", message, { view } satisfies TogglFailureDetails);
}

// 知らせに出す Project の名前。一覧を取得していなければ（Toggl を呼ばずに）ID で出す
function projectLabel(session: TogglAuth, projectId: number | null): string {
  if (projectId === null) return "Project なし";
  const project = session.deps.cache.projects(session.token)?.projects.find((p) => p.id === projectId);
  return project ? project.name : `ID ${projectId} の Project`;
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

async function failStart(
  session: TogglSession,
  previous: TogglStartFailureDetails["previous"],
  start: TogglStartFailureDetails["start"],
  res: TogglResponse,
): Promise<never> {
  const view = await refetchAfterFailure(session, res);
  const detail = failureDetail(res);
  const parts: string[] = [];
  if (previous?.stopped === true) parts.push(`前の打刻「${previous.description}」は止まりました`);
  if (previous?.stopped === false) parts.push(`前の打刻「${previous.description}」を止められませんでした（${detail}）`);
  if (previous?.stopped === "unknown") parts.push(`前の打刻「${previous.description}」が止まったかは分かりません（${detail}）`);
  if (start === "failed") parts.push(`この Issue の打刻は開始できませんでした（${detail}）`);
  if (start === "unknown") parts.push(`この Issue の打刻が開始されたかは分かりません（${detail}）`);
  if (start === "not_attempted") parts.push("この Issue の打刻は開始していません");
  const details: TogglStartFailureDetails = { previous, start, view };
  throw new NodError("TOGGL_START_FAILED", `${parts.join("。")}${view.unconfirmed ? UNCONFIRMED_SUFFIX : ""}`, details);
}

// トークンの持ち主の既定の Workspace。トークンごとにキャッシュに覚え、2 回目からの開始では /me を呼ばない
async function defaultWorkspaceId(session: TogglAuth): Promise<number> {
  const { cache } = session.deps;
  const cached = cache.workspaceId(session.token);
  if (cached !== null) return cached;
  const me = (await readToggl(session, "/me")) as { default_workspace_id?: unknown } | null;
  const id = me?.default_workspace_id;
  if (typeof id !== "number") throw new NodError("TOGGL_FAILED", "Toggl の既定の Workspace が分かりませんでした");
  cache.setWorkspaceId(session.token, id);
  return id;
}

// この Issue の打刻を、トークンの持ち主の既定の Workspace に開始する。説明は開始時点のタイトルで作り、あとから書き換えない。
// Project は projectId（null・省略なら付けない）。タグは付けない。開始の直前に現在の打刻を取り直し、別の打刻が動いていれば明示的に止めてから開始する
// （duration=-1 での開始が既存の打刻を自動で止めるかは未確認のため、それに頼らない）。
// 途中で失敗しても再送せず、取り直した状態と、前の打刻・新しい打刻それぞれの成否を返す
export async function startTogglEntry(db: Database, ref: string, deps: TogglDeps, opts: { projectId?: number | null } = {}): Promise<TogglIssueView> {
  const session = requireSession(db, ref, deps);
  let fetched: TogglSnapshot;
  let workspaceId: number;
  try {
    const blocked = blockedBy(session);
    if (blocked) throw new TogglCallError(blocked);
    fetched = await fetchCurrent(session);
    // この Issue の打刻がすでに動いていれば、二重に作らない
    if (toCurrent(fetched.entry, session.issueId)?.thisIssue) return viewOf(session, fetched);
    workspaceId = await defaultWorkspaceId(session);
  } catch (e) {
    return failBeforeWrite(session, e);
  }
  const running = fetched.entry;
  let previous: TogglStartFailureDetails["previous"] = null;
  if (running) {
    const stop = await stopEntry(session, running);
    if (outcomeOf(stop) === "gone") return abortOnConflict(session);
    if (!succeeded(stop)) {
      const stopped = writeOutcome(stop) === "failed" ? false : "unknown";
      return failStart(session, { description: running.description, stopped }, "not_attempted", stop);
    }
    // 前の打刻は止まった。この先で失敗して取り直せなくても、止まったことはキャッシュに残す
    deps.cache.set(session.token, null);
    previous = { description: running.description, stopped: true };
  }
  const body = {
    created_with: "nod",
    workspace_id: workspaceId,
    description: `${session.issueId} ${session.title}`,
    start: now(),
    duration: -1,
    ...(opts.projectId == null ? {} : { project_id: opts.projectId }),
  };
  const created = await callToggl(session, { method: "POST", path: `/workspaces/${workspaceId}/time_entries`, body });
  if (!succeeded(created)) return failStart(session, previous, writeOutcome(created), created);
  return viewOf(session, deps.cache.set(session.token, toEntry(created.body as TogglEntryBody)));
}

// この Issue の打刻を、キャッシュの打刻 ID で止める（期限切れでも使う。キャッシュが無い・成否を確認できていなければ取得する）。
// 動いている打刻がこの Issue のものでなければ止めない。止めようとした打刻がすでに止まっていた・無かったら、
// 競合として取り直した状態を返す。そのほかの失敗でも再送せずに取り直し、その状態を返す
export async function stopTogglEntry(db: Database, ref: string, deps: TogglDeps): Promise<TogglIssueView> {
  const session = requireSession(db, ref, deps);
  let snapshot: TogglSnapshot;
  try {
    const blocked = blockedBy(session);
    if (blocked) throw new TogglCallError(blocked);
    const cached = deps.cache.get(session.token);
    snapshot = cached && !deps.cache.unconfirmed(session.token) ? cached : await fetchCurrent(session);
  } catch (e) {
    return failBeforeWrite(session, e);
  }
  const current = toCurrent(snapshot.entry, session.issueId);
  if (!current?.thisIssue) throw new NodError("INVALID_STATE", `${session.issueId} の打刻は動いていません`);
  const res = await stopEntry(session, current);
  if (outcomeOf(res) === "gone") return abortOnConflict(session);
  if (!succeeded(res)) {
    const view = await refetchAfterFailure(session, res);
    const detail = failureDetail(res);
    const message = writeOutcome(res) === "failed" ? `打刻を停止できませんでした（${detail}）` : `打刻が止まったかは分かりません（${detail}）`;
    throw new NodError("TOGGL_FAILED", `${message}${view.unconfirmed ? UNCONFIRMED_SUFFIX : ""}`, { view } satisfies TogglFailureDetails);
  }
  return viewOf(session, deps.cache.set(session.token, null));
}

// この Issue の打刻の Project を変える（PUT .../time_entries/{id} に project_id。null なら Project なし）。
// 停止と同じく、キャッシュの打刻 ID で行い（キャッシュが無い・成否を確認できていなければ取得する）、この Issue の打刻でなければ変えない。
// 変えようとした打刻が無かった・すでに止まっていた（Toggl は止まった打刻も編集できるので、応答の duration で見る）なら、
// 競合として取り直した状態を返す（止まっていた打刻の Project を変えたことは知らせる）。そのほかの失敗でも再送せずに取り直し、その状態を返す
export async function setTogglEntryProject(db: Database, ref: string, deps: TogglDeps, projectId: number | null): Promise<TogglIssueView> {
  const session = requireSession(db, ref, deps);
  let snapshot: TogglSnapshot;
  try {
    const blocked = blockedBy(session);
    if (blocked) throw new TogglCallError(blocked);
    const cached = deps.cache.get(session.token);
    snapshot = cached && !deps.cache.unconfirmed(session.token) ? cached : await fetchCurrent(session);
  } catch (e) {
    return failBeforeWrite(session, e);
  }
  const current = toCurrent(snapshot.entry, session.issueId);
  if (!current?.thisIssue) throw new NodError("INVALID_STATE", `${session.issueId} の打刻は動いていません`);
  const res = await callToggl(session, { method: "PUT", path: `/workspaces/${current.workspaceId}/time_entries/${current.id}`, body: { project_id: projectId } });
  if (outcomeOf(res) === "gone") return abortOnConflict(session);
  if (!succeeded(res)) {
    const view = await refetchAfterFailure(session, res);
    const detail = failureDetail(res);
    const message = writeOutcome(res) === "failed" ? `打刻の Project を変更できませんでした（${detail}）` : `打刻の Project が変わったかは分かりません（${detail}）`;
    throw new NodError("TOGGL_FAILED", `${message}${view.unconfirmed ? UNCONFIRMED_SUFFIX : ""}`, { view } satisfies TogglFailureDetails);
  }
  const updated = res.body as TogglEntryBody;
  // 止まっていた打刻の Project は変わってしまった。戻さず（自動で再送しない）、どの打刻をどの Project にしたかを知らせる
  if (typeof updated.duration === "number" && updated.duration >= 0) {
    const reason = `Toggl の打刻「${current.description}」はほかで止まっていましたが、止まった打刻の Project を「${projectLabel(session, toEntry(updated).projectId)}」に変更しました`;
    return abortOnConflict(session, reason);
  }
  return viewOf(session, deps.cache.set(session.token, toEntry(updated)));
}

// トークンを読む。未設定なら null
function openAuth(deps: TogglDeps): TogglAuth | null {
  const token = readTogglToken(deps.configPath);
  return token === null ? null : { deps, token };
}

function projectsViewOf(snapshot: TogglProjectsSnapshot | null, failure: TogglFailure | null = null): TogglProjectsView {
  return { configured: true, projects: snapshot?.projects ?? null, fetchedAt: snapshot ? new Date(snapshot.fetchedAt).toISOString() : null, failure };
}

const UNCONFIGURED_PROJECTS: TogglProjectsView = { configured: false, projects: null, fetchedAt: null, failure: null };

// Toggl のプロジェクトの応答のうち nod が使う部分
interface TogglProjectBody {
  id: number;
  name: string;
  color?: string | null;
}

// 既定の Workspace の有効な Project を取り直し、キャッシュに入れる。失敗したら最後に分かっている一覧と理由を返す
async function fetchProjects(auth: TogglAuth): Promise<TogglProjectsView> {
  const { cache } = auth.deps;
  try {
    const workspaceId = await defaultWorkspaceId(auth);
    const body = (await readToggl(auth, `/workspaces/${workspaceId}/projects?active=true`)) as TogglProjectBody[] | null;
    const projects = (body ?? []).map((p) => ({ id: p.id, name: p.name, color: p.color ?? "" }));
    return projectsViewOf(cache.setProjects(auth.token, projects));
  } catch (e) {
    if (e instanceof TogglCallError) return projectsViewOf(cache.projects(auth.token), e.failure);
    if (e instanceof NodError) return projectsViewOf(cache.projects(auth.token), { kind: "network", detail: e.message });
    throw e;
  }
}

// 打刻の欄の Project の選択欄の一覧。一度取得したら、トークンが変わるか「最新にする」まで Toggl を呼ばない。
// 利用上限を待っている間と、同じトークンで認証に失敗したあとは Toggl を呼ばない
export async function getTogglProjects(deps: TogglDeps): Promise<TogglProjectsView> {
  const auth = openAuth(deps);
  if (auth === null) return UNCONFIGURED_PROJECTS;
  const cached = deps.cache.projects(auth.token);
  const blocked = blockedBy(auth);
  if (blocked) return projectsViewOf(cached, blocked);
  return cached ? projectsViewOf(cached) : fetchProjects(auth);
}

// 「最新にする」。一覧を取り直す（認証の失敗を覚えていても取り直す。利用上限を待っている間は Toggl を呼ばない）
export async function refreshTogglProjects(deps: TogglDeps): Promise<TogglProjectsView> {
  const auth = openAuth(deps);
  if (auth === null) return UNCONFIGURED_PROJECTS;
  return fetchProjects(auth);
}

// nod 内の開始・停止・Project の変更を 1 つずつ処理する。2 つのタブからの同時の操作が、取り直しと書き込みの間に割り込まないようにする
export function createTogglSerializer(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}
