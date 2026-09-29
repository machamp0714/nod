import type { Database } from "bun:sqlite";
import { completionStats, llmStats, recentSummary, statsQueryFromParams, summaryQueryFromParams } from "@nod/core";
import type { Hono } from "hono";

// 分析の集計。読み取り専用
export function registerStatsRoutes(app: Hono, db: Database): void {
  app.get("/api/stats", (c) => c.json(completionStats(db, statsQueryFromParams(new URL(c.req.url).searchParams))));
  app.get("/api/stats/llm", (c) => c.json(llmStats(db, statsQueryFromParams(new URL(c.req.url).searchParams))));
  // 期間の要約（#63・#76）。読み取り専用
  app.get("/api/summary", (c) => c.json(recentSummary(db, summaryQueryFromParams(new URL(c.req.url).searchParams))));
}
