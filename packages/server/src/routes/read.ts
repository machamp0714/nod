import type { Database } from "bun:sqlite";
import { listWorkspaces } from "@nod/core";
import type { Hono } from "hono";

// 読み出しの API。core の戻り値をそのまま JSON で返す
export function registerReadRoutes(app: Hono, db: Database): void {
  app.get("/api/workspaces", (c) => c.json(listWorkspaces(db)));
}
