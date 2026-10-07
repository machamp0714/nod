import { createTogglSerializer, getTogglState, type OpCtx, startTogglEntry, stopTogglEntry, type TogglDeps } from "@nod/core";
import type { Hono } from "hono";

// Toggl 打刻（NOD-6）。/api/issues/:id/:op より先に登録する。
// deps は呼ぶたびに作る（設定ファイルの場所は NOD_TOGGL_CONFIG を毎回読む）。トークンは応答に含めない
// 開始・停止はサーバー内で 1 つずつ処理する（取得は直列にしない）
export function registerTogglRoutes(app: Hono, me: OpCtx, deps: () => TogglDeps): void {
  const serial = createTogglSerializer();
  app.get("/api/issues/:id/toggl", async (c) => c.json(await getTogglState(me.db, c.req.param("id"), deps())));
  app.post("/api/issues/:id/toggl/start", async (c) => c.json(await serial(() => startTogglEntry(me.db, c.req.param("id"), deps()))));
  app.post("/api/issues/:id/toggl/stop", async (c) => c.json(await serial(() => stopTogglEntry(me.db, c.req.param("id"), deps()))));
}
