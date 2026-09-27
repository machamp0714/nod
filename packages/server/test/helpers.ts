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
