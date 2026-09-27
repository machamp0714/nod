import type { Database } from "bun:sqlite";
import { HUMAN_ACTOR, NodError, type OpCtx } from "@nod/core";
import { Hono } from "hono";
import { toErrorResponse } from "./errors";
import { registerReadRoutes } from "./routes/read";
import { registerIssueOps } from "./routes/issue-ops";
import { registerViewRoutes } from "./routes/views";
import { type ChangeFeed, createChangeFeed } from "./change-feed";
import { registerEventRoutes } from "./routes/events";

export interface AppOptions {
  db: Database;
  feed?: ChangeFeed; // 省くと、確認されない ChangeFeed を作る（テスト用）。定期的な確認は startServer が行う
}

function errorJson(err: unknown): Response {
  const { status, body } = toErrorResponse(err);
  return Response.json(body, { status });
}

// core を HTTP で公開するアプリを組み立てる。タイマーは持たない（定期的な確認は startServer が行う）
export function createApp(opts: AppOptions): Hono {
  const app = new Hono();
  app.onError((err) => errorJson(err));
  app.notFound((c) => errorJson(new NodError("NOT_FOUND", `${c.req.method} ${c.req.path} はありません`)));

  registerReadRoutes(app, opts.db);
  const me: OpCtx = { db: opts.db, actor: HUMAN_ACTOR }; // web からの操作の書き手は me
  registerIssueOps(app, me);
  registerViewRoutes(app, opts.db);
  registerEventRoutes(app, opts.feed ?? createChangeFeed(opts.db));

  app.all("/api/*", (c) => errorJson(new NodError("NOT_FOUND", `${c.req.method} ${c.req.path} はありません`)));
  return app;
}
