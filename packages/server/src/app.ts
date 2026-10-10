import type { Database } from "bun:sqlite";
import { type JevClient, type GhRunner, HUMAN_ACTOR, NodError, type OpCtx, syncClockOf, syncCycles, type TogglCache, type TogglClient } from "@nod/core";
import { Hono } from "hono";
import { toErrorResponse } from "./errors";
import { registerReadRoutes } from "./routes/read";
import { registerStatsRoutes } from "./routes/stats";
import { registerIssueOps } from "./routes/issue-ops";
import { registerDocumentOps } from "./routes/document-ops";
import { registerAttachmentRoutes } from "./routes/attachments";
import { registerIssueDeletionRoutes } from "./routes/issue-deletions";
import { registerCycleRoutes } from "./routes/cycle-ops";
import { registerInitiativeRoutes } from "./routes/initiative-ops";
import { registerProjectOps } from "./routes/project-ops";
import { registerWorkspaceRuleRoutes } from "./routes/workspace-rules";
import { registerWorkspaceLabelRoutes } from "./routes/workspace-labels";
import { registerWorkspaceTransitionRoutes } from "./routes/workspace-transitions";
import { registerRecurringRoutes } from "./routes/recurring";
import { registerTemplateRoutes } from "./routes/templates";
import { registerPrStatusRoutes } from "./routes/pr-status";
import { registerPrDiffRoutes } from "./routes/pr-diff";
import { type OrcaRunnerOption, registerOrcaRoutes } from "./routes/orca";
import { registerGithubRoutes } from "./routes/github";
import { registerTogglRoutes } from "./routes/toggl";
import { registerAutomationRoutes } from "./routes/automation";
import { registerViewRoutes } from "./routes/views";
import { registerPageDisplayRoutes } from "./routes/page-displays";
import { registerNotificationRoutes } from "./routes/notifications";
import { type ChangeFeed, createChangeFeed } from "./change-feed";
import { registerEventRoutes } from "./routes/events";
import { registerStatic } from "./static";

export interface AppOptions {
  db: Database;
  jevClient?: JevClient; // 仕様要否判定の差し替え境界。省略時は実際のJevを利用する
  feed?: ChangeFeed; // 省くと、確認されない ChangeFeed を作る（テスト用）。定期的な確認は startServer が行う
  staticDir?: string; // ビルド済みの web のディレクトリ。省くと API だけを配信する
  docsDir?: string; // 新しい Document を作る場所。省くと core の defaultDocsDir()（NOD_DOCS_DIR）
  ghRunner?: GhRunner; // PR 状態の取得で gh を実行する部分。省くと本物の gh。テストと e2e はスタブを渡す
  attachmentsDir?: string; // 添付ファイルのコピーを置く場所。省くと core の defaultAttachmentsDir()（NOD_ATTACHMENTS_DIR）
  gitRunner?: GhRunner; // origin の読み取りで git を実行する部分。省くと本物の git
  webPort?: () => number | undefined; // 検出に使う、待ち受けている実際のポート
  orcaRunner?: OrcaRunnerOption; // Orca 連携で orca を実行する部分。省くと本物の orca（NOD_ORCA=0 なら使わない）。null で無効。テストと e2e はスタブを渡す
  togglClient?: TogglClient; // Toggl 打刻で Toggl の API を呼ぶ部分。省くと本物の Toggl。テストと e2e は偽のクライアントを渡す
  togglConfigPath?: string; // Toggl のトークンの設定ファイル。省くと core の defaultTogglConfigPath()（NOD_TOGGL_CONFIG）
  togglCache?: TogglCache; // Toggl の現在の打刻のキャッシュ。省くと app ごとに作る。テストは時計を、e2e は消す口を持つものを渡す
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

  const me: OpCtx = { db: opts.db, actor: HUMAN_ACTOR }; // web からの操作の書き手は me

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
    // 周期に従って Cycle を作り、終了した Cycle の未完了を持ち越す（NOD-2）。常駐処理の代わりに、API の呼び出しのたびに確かめる
    syncCycles(me, syncClockOf(c.req.query("tz")));
    await next();
  });

  registerReadRoutes(app, opts.db, opts.docsDir);
  registerStatsRoutes(app, opts.db);
  registerAttachmentRoutes(app, me, opts.attachmentsDir); // /api/issues/:id/:op より先に登録する
  registerIssueDeletionRoutes(app, me, opts.attachmentsDir); // 同上
  registerOrcaRoutes(app, me, opts.orcaRunner); // 同上
  registerGithubRoutes(app, me, { gh: opts.ghRunner, git: opts.gitRunner, webPort: opts.webPort }); // 同上
  registerTogglRoutes(app, me, { client: opts.togglClient, configPath: opts.togglConfigPath, cache: opts.togglCache }); // 同上
  registerIssueOps(app, me, opts.jevClient);
  registerProjectOps(app, me);
  registerInitiativeRoutes(app, opts.db, me);
  registerCycleRoutes(app, me);
  registerDocumentOps(app, me, opts.docsDir);
  registerWorkspaceRuleRoutes(app, me);
  registerWorkspaceLabelRoutes(app, me);
  registerWorkspaceTransitionRoutes(app, me);
  registerRecurringRoutes(app, me, opts.jevClient);
  registerTemplateRoutes(app, me);
  registerPrStatusRoutes(app, me, opts.ghRunner);
  registerPrDiffRoutes(app, me, opts.ghRunner);
  registerAutomationRoutes(app, me, opts.jevClient);
  registerViewRoutes(app, opts.db);
  registerPageDisplayRoutes(app, opts.db);
  registerNotificationRoutes(app, opts.db, me);
  registerEventRoutes(app, opts.feed ?? createChangeFeed(opts.db));

  app.all("/api/*", (c) => errorJson(new NodError("NOT_FOUND", `${c.req.method} ${c.req.path} はありません`)));
  if (opts.staticDir) registerStatic(app, opts.staticDir);
  return app;
}
