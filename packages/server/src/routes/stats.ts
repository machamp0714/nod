import type { Database } from "bun:sqlite";
import { completionStats, llmStats, statsQueryFromParams } from "@nod/core";
import type { Hono } from "hono";

// 分析の集計。読み取り専用
export function registerStatsRoutes(app: Hono, db: Database): void {
  app.get("/api/stats", (c) => c.json(completionStats(db, statsQueryFromParams(new URL(c.req.url).searchParams))));
  app.get("/api/stats/llm", (c) => c.json(llmStats(db, statsQueryFromParams(new URL(c.req.url).searchParams))));
}
