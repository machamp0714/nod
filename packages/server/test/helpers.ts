import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUMAN_ACTOR, initWorkspace, type OpCtx, openDb } from "@nod/core";
import type { Hono } from "hono";
import { createApp } from "../src/app";

export function tempDir(prefix = "nod-server-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// テストごとに一時ファイルの DB を作り、Workspace API を1つ登録したアプリを返す
export function setup(opts: { busyTimeoutMs?: number } = {}) {
  const dbPath = join(tempDir(), "nod.db");
  const db: Database = openDb(dbPath, opts);
  const ws = initWorkspace(db, { path: "/tmp/repos/api-server" }).workspace;
  const me: OpCtx = { db, actor: HUMAN_ACTOR };
  const llm: OpCtx = { db, actor: "claude-code" };
  const app = createApp({ db });
  return { dbPath, db, ws, me, llm, app };
}

// body に文字列を渡すと、そのまま本文にする（JSON として読めない本文を試すため）
export async function call(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await app.request(path, init);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
export interface SseEvent {
  event: string;
  data: string;
}

// SSE の応答を1イベントずつ読む。timeoutMs の間に次のイベントが来なければ null を返す。
// 待ちきれなかった read() は捨てずに次の呼び出しで使う（捨てると、その後に届いたイベントを取りこぼす）
export function sseReader(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pending: ReturnType<typeof reader.read> | null = null;
  return {
    async next(timeoutMs = 2000): Promise<SseEvent | null> {
      const deadline = Date.now() + timeoutMs;
      while (!buffer.includes("\n\n")) {
        const left = deadline - Date.now();
        if (left <= 0) return null;
        pending ??= reader.read();
        const r = await Promise.race([pending, Bun.sleep(left).then(() => "timeout" as const)]);
        if (r === "timeout") return null;
        pending = null;
        if (r.done) return null;
        buffer += decoder.decode(r.value, { stream: true });
      }
      const end = buffer.indexOf("\n\n");
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const field = (name: string) =>
        block
          .split("\n")
          .find((line) => line.startsWith(`${name}: `))
          ?.slice(name.length + 2) ?? "";
      return { event: field("event"), data: field("data") };
    },
    cancel: () => reader.cancel(),
  };
}

export async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(10);
  }
  return true;
}
