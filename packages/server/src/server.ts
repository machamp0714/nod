import { defaultDbPath, type GhRunner, NodError, openDb } from "@nod/core";
import { createApp } from "./app";
import { createChangeFeed, POLL_INTERVAL_MS } from "./change-feed";

export const DEFAULT_PORT = 4700;
export const HOSTNAME = "127.0.0.1";

export interface StartServerOptions {
  port?: number; // 既定は DEFAULT_PORT。0 なら空いているポート
  dbPath?: string; // 既定は defaultDbPath()
  staticDir?: string; // ビルド済みの web のディレクトリ
  pollIntervalMs?: number; // data_version を確かめる間隔
  docsDir?: string; // 新しい Document を作る場所。既定は defaultDocsDir()（NOD_DOCS_DIR）
  ghRunner?: GhRunner; // PR 状態の取得で gh を実行する部分。e2e はスタブを渡す
}

export interface NodServer {
  url: string;
  port: number;
  dbPath: string;
  stop(): Promise<void>;
}

function isAddressInUse(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  return err?.code === "EADDRINUSE" || (typeof err?.message === "string" && err.message.includes("in use"));
}

// マイルストーン F の nod ui が呼ぶ。127.0.0.1 だけで待ち受け、起動時にマイグレーションを適用する
export function startServer(opts: StartServerOptions = {}): NodServer {
  const dbPath = opts.dbPath ?? defaultDbPath();
  const requestedPort = opts.port ?? DEFAULT_PORT;
  const db = openDb(dbPath);
  const feed = createChangeFeed(db);
  const app = createApp({ db, feed, staticDir: opts.staticDir, docsDir: opts.docsDir, ghRunner: opts.ghRunner });
  let server: ReturnType<typeof Bun.serve>;
  try {
    // idleTimeout の既定（10秒）では、書き込みのない SSE の接続が切られるため無効にする
    server = Bun.serve({ hostname: HOSTNAME, port: requestedPort, fetch: app.fetch, idleTimeout: 0 });
  } catch (e) {
    db.close();
    if (isAddressInUse(e)) {
      throw new NodError("PORT_IN_USE", `ポート ${requestedPort} はほかのプロセスが使っています。別のポートを指定してください`);
    }
    throw e;
  }
  const timer = setInterval(() => {
    try {
      feed.check();
    } catch (e) {
      console.error(e);
    }
  }, opts.pollIntervalMs ?? POLL_INTERVAL_MS);
  // TCP で起動しているため、Unix socket の場合の undefined にはならない。
  const port = server.port!;
  return {
    url: `http://${HOSTNAME}:${port}`,
    port,
    dbPath,
    async stop() {
      clearInterval(timer);
      await server.stop(true);
      db.close();
    },
  };
}
