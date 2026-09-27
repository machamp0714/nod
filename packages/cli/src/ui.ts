import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { NodError } from "@nod/core";
import type { NodServer } from "@nod/server";
import { openBrowser } from "./browser";

// packages/cli/src から見た packages/web/dist。bun build --compile の実行ファイルでは仮想のパスになるため、--web-dir で渡す
export function defaultWebDir(): string {
  return resolve(import.meta.dir, "../../web/dist");
}

export interface UiOptions {
  port?: number; // 既定は DEFAULT_PORT
  webDir: string;
  dbPath?: string; // 省くと startServer の既定（NOD_DB か ~/.local/share/nod/nod.db）
  open: boolean;
}

export interface UiDeps {
  openBrowser(url: string): Promise<boolean>;
}

export interface UiStarted {
  url: string;
  reused: boolean;
  opened: boolean;
  dbPath: string | null;
  webDir: string;
  server: NodServer | null;
}

// API が Workspace の配列を返し、/ が HTML を返せば、web を配信している nod の server とみなす
async function isNodUi(origin: string): Promise<boolean> {
  try {
    const api = await fetch(`${origin}/api/workspaces`, { signal: AbortSignal.timeout(1000) });
    if (api.status !== 200 || !Array.isArray(await api.json())) return false;
    const page = await fetch(`${origin}/`, { signal: AbortSignal.timeout(1000) });
    return page.status === 200 && (page.headers.get("content-type") ?? "").includes("text/html");
  } catch {
    return false;
  }
}

export async function startUi(opts: UiOptions, deps: UiDeps = { openBrowser }): Promise<UiStarted> {
  const webDir = resolve(opts.webDir);
  if (!existsSync(join(webDir, "index.html"))) {
    throw new NodError(
      "WEB_NOT_BUILT",
      `${webDir} に index.html がありません。リポジトリのルートで bun run web:build を実行するか、--web-dir でビルド済みの web のディレクトリを指定してください`,
    );
  }
  // hono を含む server は nod ui のときだけ読み込む。ほかのコマンドの起動を遅くしないため
  const { DEFAULT_PORT, HOSTNAME, startServer } = await import("@nod/server");
  const port = opts.port ?? DEFAULT_PORT;
  let server: NodServer | null = null;
  let origin: string;
  try {
    server = startServer({ port, dbPath: opts.dbPath, staticDir: webDir });
    origin = server.url;
  } catch (e) {
    if ((e as { code?: string }).code !== "PORT_IN_USE") throw e;
    origin = `http://${HOSTNAME}:${port}`;
    if (!(await isNodUi(origin))) {
      throw new NodError(
        "PORT_IN_USE",
        `ポート ${port} はほかのプログラムが使っています。nod ui --port <番号> で別のポートを指定してください`,
      );
    }
  }
  const url = `${origin}/`;
  const opened = opts.open ? await deps.openBrowser(url) : false;
  return { url, reused: server === null, opened, dbPath: server?.dbPath ?? null, webDir, server };
}
