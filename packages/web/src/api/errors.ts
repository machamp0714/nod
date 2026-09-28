import { ApiError } from "./client";

// 404 と、ID の形が違う INVALID_ARGS（/issues/nope など）を「見つかりません」として表示する
export function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.code === "INVALID_ARGS");
}

// 画面に出す失敗の理由。apiFetch は、server が答えたら ApiError を、答えなければ fetch の TypeError を投げる
export function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : "server に接続できません";
}

// 4xx は何度呼んでも同じ結果になるため再試行しない。5xx と通信の失敗は3回まで再試行する
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 3;
}
