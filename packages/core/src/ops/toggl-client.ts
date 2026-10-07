import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Toggl Track の打刻（NOD-6）で Toggl の API を呼ぶクライアントと、トークンの設定ファイルの読み込み

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
