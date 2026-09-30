import { defaultOrcaRunner, type OpCtx, openInOrca, type OrcaRunner } from "@nod/core";
import type { Hono } from "hono";

// orca を使う部分。undefined なら毎回 NOD_ORCA・ORCA_CLI_COMMAND を読んで本物の orca を使い、null なら使わない
export type OrcaRunnerOption = OrcaRunner | null | undefined;

export function resolveOrcaRunner(orca: OrcaRunnerOption): OrcaRunner | null {
  return orca === undefined ? defaultOrcaRunner() : orca;
}

// Orca 連携（#52）。記録済みの worktree を Orca で前面に出すだけで、セッションの起動・再開はしない
export function registerOrcaRoutes(app: Hono, me: OpCtx, orca: OrcaRunnerOption): void {
  app.post("/api/issues/:id/orca-open", async (c) => c.json(await openInOrca(me.db, c.req.param("id"), resolveOrcaRunner(orca))));
}
