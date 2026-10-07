import {
  createTogglCache,
  createTogglSerializer,
  defaultTogglConfigPath,
  getTogglState,
  type OpCtx,
  refreshTogglState,
  startTogglEntry,
  stopTogglEntry,
  type TogglCache,
  type TogglClient,
  type TogglDeps,
  togglClient,
} from "@nod/core";
import type { Hono } from "hono";

export interface TogglRouteOptions {
  client?: TogglClient; // 省くと本物の Toggl
  configPath?: string; // 省くと core の defaultTogglConfigPath()（NOD_TOGGL_CONFIG を毎回読む）
  cache?: TogglCache; // 省くと app ごとに作る
}

// Toggl 打刻（NOD-6）。/api/issues/:id/:op より先に登録する。
// deps は呼ぶたびに作る（設定ファイルの場所は NOD_TOGGL_CONFIG を毎回読む）。トークンは応答に含めない
// 開始・停止はサーバー内で 1 つずつ処理する（取得は直列にしない）。
// 現在の打刻は cache（app に 1 つ）で 5 分持ち、refresh（「最新にする」）だけがキャッシュを無視して取り直す
export function registerTogglRoutes(app: Hono, me: OpCtx, opts: TogglRouteOptions = {}): void {
  const cache = opts.cache ?? createTogglCache();
  const deps = (): TogglDeps => ({ client: opts.client ?? togglClient, configPath: opts.configPath ?? defaultTogglConfigPath(), cache });
  const serial = createTogglSerializer();
  app.get("/api/issues/:id/toggl", async (c) => c.json(await getTogglState(me.db, c.req.param("id"), deps())));
  app.post("/api/issues/:id/toggl/refresh", async (c) => c.json(await refreshTogglState(me.db, c.req.param("id"), deps())));
  app.post("/api/issues/:id/toggl/start", async (c) => c.json(await serial(() => startTogglEntry(me.db, c.req.param("id"), deps()))));
  app.post("/api/issues/:id/toggl/stop", async (c) => c.json(await serial(() => stopTogglEntry(me.db, c.req.param("id"), deps()))));
}
