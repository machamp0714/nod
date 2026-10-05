import {
  clearCadence,
  createCycle,
  type CycleClock,
  cycleAnalytics,
  deleteCycle,
  getCadence,
  getCycle,
  listCycles,
  type OpCtx,
  setCadence,
  updateCycle,
} from "@nod/core";
import type { Context, Hono } from "hono";
import { optBool, optString, paramInt, readBody, reqInt, reqString } from "../input";

// 「現在」の判定に使うタイムゾーン。Web はブラウザのタイムゾーンを渡す。省略時はサーバーのローカル
function clockOf(c: Context): CycleClock {
  const tz = c.req.query("tz");
  return tz ? { tz } : {};
}

// Cycle（#82・NOD-2）。書き手は me 固定。Cycle は ID で指す
export function registerCycleRoutes(app: Hono, me: OpCtx): void {
  const cycleId = (value: string) => String(paramInt(value, "Cycle の ID "));

  app.get("/api/cycles", (c) => c.json(listCycles(me.db, clockOf(c))));
  app.post("/api/cycles", async (c) => {
    const body = await readBody(c, ["name", "startDate", "endDate"]);
    const created = createCycle(me, { name: reqString(body, "name"), startDate: reqString(body, "startDate"), endDate: reqString(body, "endDate") }, clockOf(c));
    return c.json(created, 201);
  });
  app.get("/api/cycle-cadence", (c) => c.json(getCadence(me.db)));
  app.put("/api/cycle-cadence", async (c) => {
    const body = await readBody(c, ["weeks", "autoCarryOver", "anchorDate"]);
    return c.json(setCadence(me, { weeks: reqInt(body, "weeks"), autoCarryOver: optBool(body, "autoCarryOver"), anchorDate: optString(body, "anchorDate") }, clockOf(c)));
  });
  app.delete("/api/cycle-cadence", (c) => {
    clearCadence(me);
    return c.json({ ok: true });
  });
  app.get("/api/cycles/:id/analytics", (c) => c.json(cycleAnalytics(me.db, cycleId(c.req.param("id")), clockOf(c))));
  app.get("/api/cycles/:id", (c) => c.json(getCycle(me.db, cycleId(c.req.param("id")), clockOf(c))));
  app.post("/api/cycles/:id/update", async (c) => {
    const body = await readBody(c, ["name", "startDate", "endDate"]);
    return c.json(updateCycle(me, cycleId(c.req.param("id")), { name: optString(body, "name"), startDate: optString(body, "startDate"), endDate: optString(body, "endDate") }, clockOf(c)));
  });
  app.delete("/api/cycles/:id", (c) => c.json(deleteCycle(me, cycleId(c.req.param("id")), clockOf(c))));
}
