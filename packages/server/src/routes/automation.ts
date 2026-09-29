import { type AutomationTargets, getAutomationSettings, type OpCtx, runAutomation, setAutomationSettings } from "@nod/core";
import type { Hono } from "hono";
import { invalid, optInt, optNullableInt, readBody } from "../input";

function optTargets(value: unknown): AutomationTargets | undefined {
  if (value === undefined) return undefined;
  const message = "targets は { auto_close?: string[], auto_archive?: string[], pr_review?: string[] } で指定してください";
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(message);
  const targets = value as Record<string, unknown>;
  if (Object.keys(targets).some((key) => !["auto_close", "auto_archive", "pr_review"].includes(key))) throw invalid(message);
  // 配列の中身と件数は core で確かめる
  return targets as AutomationTargets;
}

// 自動化（#71・#72）は web（実行者 me）から設定・確認・1回実行する。常駐の実行はしない
export function registerAutomationRoutes(app: Hono, me: OpCtx): void {
  app.get("/api/workspaces/:key/automation", (c) => c.json(getAutomationSettings(me.db, c.req.param("key"))));
  app.put("/api/workspaces/:key/automation", async (c) => {
    const body = await readBody(c, ["closeAfterDays", "archiveAfterDays", "prReview"]);
    if (body.prReview !== undefined && typeof body.prReview !== "boolean") throw invalid("prReview は true か false で指定してください");
    return c.json(
      setAutomationSettings(me, c.req.param("key"), {
        closeAfterDays: optNullableInt(body, "closeAfterDays"),
        archiveAfterDays: optNullableInt(body, "archiveAfterDays"),
        prReview: body.prReview as boolean | undefined,
      }),
    );
  });
  // dryRun を省いたら dry-run（安全側）。実行するには dryRun: false を明示する。
  // targets（{ auto_close?: string[]; auto_archive?: string[]; pr_review?: string[] }）は確認時点の一覧で、そのうちいまも条件に合うものだけを処理する。
  // targets を渡したときに pr_review の一覧がなければ、PR 連動は何もしない
  app.post("/api/workspaces/:key/automation/run", async (c) => {
    const body = await readBody(c, ["dryRun", "limit", "targets"]);
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") throw invalid("dryRun は true か false で指定してください");
    return c.json(
      runAutomation(me, c.req.param("key"), {
        dryRun: body.dryRun !== false,
        limit: optInt(body, "limit"),
        targets: optTargets(body.targets),
      }),
    );
  });
}
