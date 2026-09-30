import { getTransitionRules, type OpCtx, resetTransitionRules, setTransitionRules } from "@nod/core";
import type { Hono } from "hono";
import { invalid, optStringArray, readBody } from "../input";

// ステータスの遷移ルール（#73）。変更は web（書き手 me）と CLI の人だけ。LLM は読むだけ
export function registerWorkspaceTransitionRoutes(app: Hono, me: OpCtx): void {
  app.get("/api/workspaces/:key/transitions", (c) => c.json(getTransitionRules(me.db, c.req.param("key"))));
  app.put("/api/workspaces/:key/transitions", async (c) => {
    const body = await readBody(c, ["forbidden", "presets"]);
    const forbidden = body.forbidden ?? [];
    if (
      !Array.isArray(forbidden) ||
      forbidden.some(
        (p) => typeof p !== "object" || p === null || Array.isArray(p) || typeof p.from !== "string" || typeof p.to !== "string",
      )
    ) {
      throw invalid("forbidden は { from, to }（ステータスの内部値）の配列で指定してください");
    }
    return c.json(
      setTransitionRules(me, c.req.param("key"), {
        forbidden: (forbidden as { from: string; to: string }[]).map(({ from, to }) => ({ from, to })),
        presets: optStringArray(body, "presets") ?? [],
      }),
    );
  });
  app.delete("/api/workspaces/:key/transitions", (c) => c.json(resetTransitionRules(me, c.req.param("key"))));
}
