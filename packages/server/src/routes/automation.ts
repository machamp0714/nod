import { getAutomationSettings, type OpCtx, runAutomation, setAutomationSettings } from "@nod/core";
import type { Hono } from "hono";
import { invalid, optInt, optNullableInt, readBody } from "../input";

// 自動化（#71・#72）は web（実行者 me）から設定・確認・1回実行する。常駐の実行はしない
export function registerAutomationRoutes(app: Hono, me: OpCtx): void {
  app.get("/api/workspaces/:key/automation", (c) => c.json(getAutomationSettings(me.db, c.req.param("key"))));
  app.put("/api/workspaces/:key/automation", async (c) => {
    const body = await readBody(c, ["closeAfterDays", "archiveAfterDays"]);
    return c.json(
      setAutomationSettings(me, c.req.param("key"), {
        closeAfterDays: optNullableInt(body, "closeAfterDays"),
        archiveAfterDays: optNullableInt(body, "archiveAfterDays"),
      }),
    );
  });
  app.post("/api/workspaces/:key/automation/run", async (c) => {
    const body = await readBody(c, ["dryRun", "limit"]);
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") throw invalid("dryRun は true か false で指定してください");
    return c.json(runAutomation(me, c.req.param("key"), { dryRun: body.dryRun === true, limit: optInt(body, "limit") }));
  });
}
