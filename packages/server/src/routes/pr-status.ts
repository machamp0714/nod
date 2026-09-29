import { type GhRunner, getPrStatus, type OpCtx, refreshPrStatus } from "@nod/core";
import type { Hono } from "hono";

// PR 状態（#67）。更新は web の「更新」ボタンからだけ呼ばれ、gh で GitHub を読み取る（書き込まない）
export function registerPrStatusRoutes(app: Hono, me: OpCtx, gh?: GhRunner): void {
  app.get("/api/issues/:id/pr-status", (c) => c.json(getPrStatus(me.db, c.req.param("id"))));
  app.post("/api/issues/:id/pr-status/refresh", async (c) => c.json(await refreshPrStatus(me, c.req.param("id"), gh)));
}
