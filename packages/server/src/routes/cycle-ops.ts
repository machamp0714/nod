import {
  createCycle,
  type CycleClock,
  cycleWorkspaceId,
  deleteCycle,
  findWorkspace,
  getCycle,
  listAllCycles,
  moveOpenIssues,
  NodError,
  type OpCtx,
  updateCycle,
} from "@nod/core";
import type { Context, Hono } from "hono";
import { optString, paramInt, readBody, reqString } from "../input";

function workspaceIdOf(me: OpCtx, key: string): number {
  const ws = findWorkspace(me.db, key);
  if (!ws) throw new NodError("NOT_FOUND", `Workspace ${key} はありません`);
  return ws.id;
}

// 「現在」の判定に使うタイムゾーン。Web はブラウザのタイムゾーンを渡す。省略時はサーバーのローカル
function clockOf(c: Context): CycleClock {
  const tz = c.req.query("tz");
  return tz ? { tz } : {};
}

// Cycle（#82）。書き手は me 固定。Cycle は ID で指し、作るときだけ Workspace のキーを使う
export function registerCycleRoutes(app: Hono, me: OpCtx): void {
  const cycleId = (value: string) => paramInt(value, "Cycle の ID ");

  app.get("/api/cycles", (c) => {
    const keys = new URL(c.req.url).searchParams.getAll("workspace").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
    return c.json(listAllCycles(me.db, { workspaceIds: keys.length ? keys.map((k) => workspaceIdOf(me, k)) : undefined, ...clockOf(c) }));
  });
  app.post("/api/workspaces/:key/cycles", async (c) => {
    const body = await readBody(c, ["name", "startDate", "endDate"]);
    const created = createCycle(
      me,
      { workspaceId: workspaceIdOf(me, c.req.param("key")), name: reqString(body, "name"), startDate: reqString(body, "startDate"), endDate: reqString(body, "endDate") },
      clockOf(c),
    );
    return c.json(created, 201);
  });
  app.get("/api/cycles/:id", (c) => {
    const id = cycleId(c.req.param("id"));
    return c.json(getCycle(me.db, cycleWorkspaceId(me.db, id), String(id), clockOf(c)));
  });
  app.post("/api/cycles/:id/update", async (c) => {
    const body = await readBody(c, ["name", "startDate", "endDate"]);
    const id = cycleId(c.req.param("id"));
    return c.json(
      updateCycle(
        me,
        cycleWorkspaceId(me.db, id),
        String(id),
        { name: optString(body, "name"), startDate: optString(body, "startDate"), endDate: optString(body, "endDate") },
        clockOf(c),
      ),
    );
  });
  app.delete("/api/cycles/:id", (c) => {
    const id = cycleId(c.req.param("id"));
    return c.json(deleteCycle(me, cycleWorkspaceId(me.db, id), String(id), clockOf(c)));
  });
  // 未完了の Issue を別の Cycle へまとめて移す。to は同じ Workspace の Cycle の ID
  app.post("/api/cycles/:id/move-open", async (c) => {
    const body = await readBody(c, ["to"]);
    const id = cycleId(c.req.param("id"));
    const to = String(cycleId(reqString(body, "to")));
    return c.json(moveOpenIssues(me, cycleWorkspaceId(me.db, id), String(id), to, clockOf(c)));
  });
}
