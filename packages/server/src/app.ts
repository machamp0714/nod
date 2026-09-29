import type { Database } from "bun:sqlite";
import { HUMAN_ACTOR, NodError, type OpCtx } from "@nod/core";
import { Hono } from "hono";
import { toErrorResponse } from "./errors";
import { registerReadRoutes } from "./routes/read";
import { registerIssueOps } from "./routes/issue-ops";
import { registerDocumentOps } from "./routes/document-ops";
import { registerProjectOps } from "./routes/project-ops";
import { registerViewRoutes } from "./routes/views";
import { type ChangeFeed, createChangeFeed } from "./change-feed";
import { registerEventRoutes } from "./routes/events";
import { registerStatic } from "./static";

export interface AppOptions {
  db: Database;
  feed?: ChangeFeed; // 省くと、確認されない ChangeFeed を作る（テスト用）。定期的な確認は startServer が行う
  staticDir?: string; // ビルド済みの web のディレクトリ。省くと API だけを配信する
  docsDir?: string; // 新しい Document を作る場所。省くと core の defaultDocsDir()（NOD_DOCS_DIR）
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

  app.use("/api/*", async (c, next) => {
    // Hono の HEAD→GET 変換で SSE の購読を作らない。API は明示したメソッドだけを受け付ける
    if (c.req.method === "HEAD") {
      throw new NodError("NOT_FOUND", `${c.req.method} ${c.req.path} はありません`);
    }
    if (["POST", "PUT", "DELETE"].includes(c.req.method)) {
      // ローカルの Vite 転送を許可し、外部サイトから me として操作されることを防ぐ
      const origin = c.req.header("Origin");
      let allowed = c.req.header("Sec-Fetch-Site") !== "cross-site";
      if (origin !== undefined) {
        try {
          const url = new URL(origin);
          allowed &&= ["http:", "https:"].includes(url.protocol)
            && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        } catch {
          allowed = false;
        }
      }
      if (!allowed) throw new NodError("FORBIDDEN_ORIGIN", "外部サイトからの書き込みは受け付けません");
    }
    await next();
  });

  registerReadRoutes(app, opts.db);
  const me: OpCtx = { db: opts.db, actor: HUMAN_ACTOR }; // web からの操作の書き手は me
  registerIssueOps(app, me);
  registerProjectOps(app, me);
  registerDocumentOps(app, me, opts.docsDir);
  registerViewRoutes(app, opts.db);
  registerEventRoutes(app, opts.feed ?? createChangeFeed(opts.db));

  app.all("/api/*", (c) => errorJson(new NodError("NOT_FOUND", `${c.req.method} ${c.req.path} はありません`)));
  if (opts.staticDir) registerStatic(app, opts.staticDir);
  return app;
}
