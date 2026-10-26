import { NodError, cycleAnalytics, resolveLegacyCycle, type OpCtx } from "@nod/core";
import type { Hono } from "hono";
import { paramInt } from "../input";

export function registerCycleRoutes(app: Hono, me: OpCtx): void {
  const retired = (): never => {
    throw new NodError("CYCLE_RETIRED", "Cycleと周期操作は廃止されました。履歴は /api/sprints を利用してください。Sprintの合意・採択・開始は後続の操作へ移行します");
  };
  app.get("/api/cycles/:id/analytics", c => c.json(cycleAnalytics(me.db,String(paramInt(c.req.param("id"),"旧Cycle ID")),{tz:c.req.query("tz")})));
  app.get("/api/cycles/:id", c => c.json(resolveLegacyCycle(me.db,paramInt(c.req.param("id"),"旧Cycle ID"))));
  app.all("/api/cycle-cadence", retired);
  app.all("/api/cycles", retired);
  app.all("/api/cycles/*", retired);
}
