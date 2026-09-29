import { type GhRunner, getPrDiff, type OpCtx, refreshPrDiff } from "@nod/core";
import type { Hono } from "hono";

// PR の差分（#55）。更新は web の「更新」ボタンからだけ呼ばれ、gh で GitHub を読み取る（書き込まない）
export function registerPrDiffRoutes(app: Hono, me: OpCtx, gh?: GhRunner): void {
  app.get("/api/issues/:id/pr-diff", (c) => c.json(getPrDiff(me.db, c.req.param("id"))));
  app.post("/api/issues/:id/pr-diff/refresh", async (c) => c.json(await refreshPrDiff(me, c.req.param("id"), gh)));
}
