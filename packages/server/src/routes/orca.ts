import {
  defaultOrcaRunner,
  getAgentTargets,
  listInstructions,
  type OpCtx,
  openInOrca,
  type OrcaRunner,
  recordInstruction,
  sendInstruction,
} from "@nod/core";
import type { Hono } from "hono";
import { invalid, paramInt, readBody, reqString } from "../input";

// orca を使う部分。undefined なら毎回 NOD_ORCA・ORCA_CLI_COMMAND を読んで本物の orca を使い、null なら使わない
export type OrcaRunnerOption = OrcaRunner | null | undefined;

export function resolveOrcaRunner(orca: OrcaRunnerOption): OrcaRunner | null {
  return orca === undefined ? defaultOrcaRunner() : orca;
}

// Orca 連携。/api/issues/:id/:op より先に登録する。
// #52 記録済みの worktree を Orca で前面に出すだけで、セッションの起動・再開はしない。
// #51 追加指示は記録と送信を分け、送信は確認画面からの明示操作でだけ呼ばれる（自動送信はしない）
export function registerOrcaRoutes(app: Hono, me: OpCtx, orca: OrcaRunnerOption): void {
  app.post("/api/issues/:id/orca-open", async (c) => c.json(await openInOrca(me.db, c.req.param("id"), resolveOrcaRunner(orca))));
  app.get("/api/issues/:id/agent-targets", async (c) => c.json(await getAgentTargets(me.db, c.req.param("id"), resolveOrcaRunner(orca))));
  app.get("/api/issues/:id/instructions", (c) => c.json(listInstructions(me.db, c.req.param("id"))));
  app.post("/api/issues/:id/instructions", async (c) => {
    const body = await readBody(c, ["body"]);
    return c.json(recordInstruction(me, c.req.param("id"), reqString(body, "body")), 201);
  });
  app.post("/api/issues/:id/instructions/:instructionId/send", async (c) => {
    const body = await readBody(c, ["terminal", "confirmResend"]);
    if (body.confirmResend !== undefined && typeof body.confirmResend !== "boolean") {
      throw invalid("confirmResend は true か false で指定してください");
    }
    const instructionId = paramInt(c.req.param("instructionId"), "追加指示の ID");
    const input = { terminal: reqString(body, "terminal"), confirmResend: body.confirmResend === true };
    return c.json(await sendInstruction(me, c.req.param("id"), instructionId, input, resolveOrcaRunner(orca)));
  });
}
