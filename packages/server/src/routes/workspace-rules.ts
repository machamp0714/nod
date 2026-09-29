import { clearWorkspaceRules, getWorkspaceRules, type OpCtx, setWorkspaceRules } from "@nod/core";
import type { Hono } from "hono";
import { readBody, reqString } from "../input";

// 作業規約は web（書き手 me）からだけ変更する。LLM は CLI で読むだけ
export function registerWorkspaceRuleRoutes(app: Hono, me: OpCtx): void {
  app.get("/api/workspaces/:key/rules", (c) => c.json(getWorkspaceRules(me.db, c.req.param("key"))));
  app.put("/api/workspaces/:key/rules", async (c) => {
    const body = await readBody(c, ["body"]);
    return c.json(setWorkspaceRules(me, c.req.param("key"), reqString(body, "body")));
  });
  app.delete("/api/workspaces/:key/rules", (c) => c.json(clearWorkspaceRules(me, c.req.param("key"))));
}
