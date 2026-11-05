import type { Database } from "bun:sqlite";
import { type JevClient, defaultDbPath, type GhRunner, NodError, openDb, syncSprintRollover, type TogglCache, type TogglClient } from "@nod/core";
import type { OrcaRunnerOption } from "./routes/orca";
import { createApp } from "./app";
import { type ChangeFeed, createChangeFeed, POLL_INTERVAL_MS } from "./change-feed";

export const DEFAULT_PORT = 4700;
// 期限到来時の自動引継ぎを確かめる既定の間隔（1分）
export const ROLLOVER_INTERVAL_MS = 60_000;
export const HOSTNAME = "127.0.0.1";

export interface StartServerOptions {
  jevClient?: JevClient; // 自動テストでは実APIの代わりに渡す
  port?: number; // 既定は DEFAULT_PORT。0 なら空いているポート
  dbPath?: string; // 既定は defaultDbPath()
  staticDir?: string; // ビルド済みの web のディレクトリ
  pollIntervalMs?: number; // data_version を確かめる間隔
  docsDir?: string; // 新しい Document を作る場所。既定は defaultDocsDir()（NOD_DOCS_DIR）
  ghRunner?: GhRunner; // PR 状態の取得で gh を実行する部分。e2e はスタブを渡す
  attachmentsDir?: string; // 添付ファイルのコピーを置く場所。既定は defaultAttachmentsDir()（NOD_ATTACHMENTS_DIR）
  orcaRunner?: OrcaRunnerOption; // Orca 連携で orca を実行する部分。e2e はスタブを渡す
  togglClient?: TogglClient; // Toggl 打刻で Toggl の API を呼ぶ部分。e2e は偽のクライアントを渡す
  togglConfigPath?: string; // Toggl のトークンの設定ファイル。既定は defaultTogglConfigPath()（NOD_TOGGL_CONFIG）
  togglCache?: TogglCache; // Toggl の現在の打刻のキャッシュ。e2e はテストごとに消せるものを渡す
  rolloverIntervalMs?: number; // 自動引継ぎを確かめる間隔。既定は ROLLOVER_INTERVAL_MS。起動時の1回は間隔によらず行う
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

// 期限到来時の自動引継ぎ。失敗はログに出して次の契機で再試行する。
// 自動処理の書き込みは同じ接続なので data_version が変わらず、変更があれば購読者へ直接知らせる
function syncRollover(db: Database, feed: ChangeFeed): void {
  try {
    let changed = false;
    for (const result of syncSprintRollover(db)) {
      if (result.error) console.error(`Sprintの自動引継ぎに失敗しました（${result.workspaceKey}）: ${result.error.message}`);
      if (result.ended.length || result.successors.length || result.started.length || result.carried) changed = true;
    }
    if (changed) feed.notify();
  } catch (e) {
    console.error(e);
  }
}

// マイルストーン F の nod ui が呼ぶ。127.0.0.1 だけで待ち受け、起動時にマイグレーションを適用する
export function startServer(opts: StartServerOptions = {}): NodServer {
  const dbPath = opts.dbPath ?? defaultDbPath();
  const requestedPort = opts.port ?? DEFAULT_PORT;
  const db = openDb(dbPath);
  const feed = createChangeFeed(db);
  let boundPort: number | undefined;
  const app = createApp({ db, feed, jevClient: opts.jevClient, webPort: () => boundPort, staticDir: opts.staticDir, docsDir: opts.docsDir, ghRunner: opts.ghRunner, attachmentsDir: opts.attachmentsDir, orcaRunner: opts.orcaRunner, togglClient: opts.togglClient, togglConfigPath: opts.togglConfigPath, togglCache: opts.togglCache });
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
  syncRollover(db, feed);
  const rolloverTimer = setInterval(() => syncRollover(db, feed), opts.rolloverIntervalMs ?? ROLLOVER_INTERVAL_MS);
  // TCP で起動しているため、Unix socket の場合の undefined にはならない。
  const port = server.port!;
  boundPort = port;
  return {
    url: `http://${HOSTNAME}:${port}`,
    port,
    dbPath,
    async stop() {
      clearInterval(timer);
      clearInterval(rolloverTimer);
      await server.stop(true);
      db.close();
    },
  };
}
