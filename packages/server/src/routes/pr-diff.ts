import { type GhRunner, getPrDiff, getPrDiffFile, type OpCtx, refreshPrDiff } from "@nod/core";
import type { Hono } from "hono";
import { invalid } from "../input";

// PR の差分（#55）。更新は web の「更新」ボタンからだけ呼ばれ、gh で GitHub を読み取る（書き込まない）。
// GET はファイルの一覧と要約だけを返し、patch は files?path= でファイルごとに返す（開いたファイルだけを読むため）
export function registerPrDiffRoutes(app: Hono, me: OpCtx, gh?: GhRunner): void {
  app.get("/api/issues/:id/pr-diff", (c) => c.json(getPrDiff(me.db, c.req.param("id"))));
  app.get("/api/issues/:id/pr-diff/files", (c) => {
    const path = c.req.query("path");
    if (!path) throw invalid("path を指定してください");
    return c.json(getPrDiffFile(me.db, c.req.param("id"), path));
  });
  app.post("/api/issues/:id/pr-diff/refresh", async (c) => c.json(await refreshPrDiff(me, c.req.param("id"), gh)));
}
