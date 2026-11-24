import { setWorkspaceSpecAssessment, clearWorkspaceRules, getWorkspaceRules, type OpCtx, setWorkspaceRules } from "@nod/core";
import type { Hono } from "hono";
import { invalid, readBody, reqString } from "../input";

// Web からの作業規約の変更は、書き手 me として記録する。
export function registerWorkspaceRuleRoutes(app: Hono, me: OpCtx): void {
  app.put("/api/workspaces/:key/spec-assessment", async (c) => {
    const body = await readBody(c, ["enabled"]);
    if (typeof body.enabled !== "boolean") throw invalid("enabled は true か false で指定してください");
    return c.json(setWorkspaceSpecAssessment(me, c.req.param("key"), body.enabled));
  });
  app.get("/api/workspaces/:key/rules", (c) => c.json(getWorkspaceRules(me.db, c.req.param("key"))));
  app.put("/api/workspaces/:key/rules", async (c) => {
    const body = await readBody(c, ["body"]);
    return c.json(setWorkspaceRules(me, c.req.param("key"), reqString(body, "body")));
  });
  app.delete("/api/workspaces/:key/rules", (c) => c.json(clearWorkspaceRules(me, c.req.param("key"))));
}
