import type { TogglEntry, TogglFailure } from "./toggl";

// Toggl Track の打刻（NOD-6）の、サーバーのメモリに持つキャッシュ

export const TOGGL_CACHE_TTL_MS = 5 * 60_000;

// Toggl の現在の打刻を、取得したトークンと時刻とともに持つ
export interface TogglSnapshot {
  token: string;
  entry: TogglEntry | null;
  fetchedAt: number; // epoch ミリ秒
}

// キャッシュの世代。開始・停止の結果や成否不明が入るたびに進む
export type TogglCacheGeneration = number;

// 現在の打刻のキャッシュ。サーバーのメモリに 1 つだけ持ち、すべての Issue・タブで共有する（Toggl の現在の打刻の取得は毎時 30 回まで）。
// 期限が切れても最後に分かっている打刻は残す（停止は期限切れでもこの打刻 ID で行う）。
// 利用上限の待ち（quota）、認証の失敗（authFailure）、開始・停止の成否を確認できていないこと（unconfirmed）、
// トークンの持ち主の既定の Workspace も持つ。
// トークンが変わったら捨てる
export interface TogglCache {
  now: () => number; // epoch ミリ秒。テストは時計を差し替える
  ttlMs: number;
  get(token: string): TogglSnapshot | null; // 最後に分かっている現在の打刻（期限切れも返す）
  // 現在の打刻を入れ、unconfirmed を解く。fetchStartedAt は取得を始めたときの generation()（開始・停止の結果なら省く）。
  // その後に開始・停止の結果（fetchStartedAt なしの set）や成否不明が入っていたら、遅れて届いた取得の結果で上書きせず、今の内容を返す
  set(token: string, entry: TogglEntry | null, fetchStartedAt?: TogglCacheGeneration): TogglSnapshot;
  generation(): TogglCacheGeneration;
  quota(token: string): TogglFailure | null; // 利用上限の待ち。待ち終わっていれば null
  setQuota(token: string, failure: TogglFailure): void;
  // 認証の失敗。同じトークンのままでは表示のたびに Toggl を呼ばない（「最新にする」では取り直す）。Toggl を呼べたら null に戻す
  authFailure(token: string): TogglFailure | null;
  setAuthFailure(token: string, failure: TogglFailure | null): void;
  unconfirmed(token: string): boolean;
  setUnconfirmed(token: string): void;
  workspaceId(token: string): number | null; // 既定の Workspace（/me の default_workspace_id）。まだ分かっていなければ null
  setWorkspaceId(token: string, id: number): void;
  clear(): void;
}

export function createTogglCache(opts: { now?: () => number; ttlMs?: number } = {}): TogglCache {
  let state: { token: string; snapshot: TogglSnapshot | null; quota: TogglFailure | null; authFailure: TogglFailure | null; unconfirmed: boolean; workspaceId: number | null } | null = null;
  let generation: TogglCacheGeneration = 0;
  const now = opts.now ?? Date.now;
  // このトークンの状態。トークンが変わっていたら捨てて作り直す
  const stateFor = (token: string) => {
    if (state?.token !== token) state = { token, snapshot: null, quota: null, authFailure: null, unconfirmed: false, workspaceId: null };
    return state;
  };
  return {
    now,
    ttlMs: opts.ttlMs ?? TOGGL_CACHE_TTL_MS,
    get(token) {
      return stateFor(token).snapshot;
    },
    set(token, entry, fetchStartedAt) {
      const s = stateFor(token);
      if (fetchStartedAt !== undefined && fetchStartedAt !== generation && s.snapshot) return s.snapshot;
      if (fetchStartedAt === undefined) generation++;
      s.snapshot = { token, entry, fetchedAt: now() };
      s.unconfirmed = false;
      return s.snapshot;
    },
    generation: () => generation,
    quota(token) {
      const s = stateFor(token);
      if (s.quota && Date.parse(s.quota.retryAfter ?? "") <= now()) s.quota = null;
      return s.quota;
    },
    setQuota(token, failure) {
      stateFor(token).quota = failure;
    },
    authFailure: (token) => stateFor(token).authFailure,
    setAuthFailure(token, failure) {
      stateFor(token).authFailure = failure;
    },
    unconfirmed: (token) => stateFor(token).unconfirmed,
    setUnconfirmed(token) {
      // 遅れて届いた取得の結果（操作の前の状態）で、成否不明を解かないようにする
      generation++;
      stateFor(token).unconfirmed = true;
    },
    workspaceId: (token) => stateFor(token).workspaceId,
    setWorkspaceId(token, id) {
      stateFor(token).workspaceId = id;
    },
    clear() {
      state = null;
    },
  };
}
