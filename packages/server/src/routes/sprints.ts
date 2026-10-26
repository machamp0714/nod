import { getSprint, listSprints, sprintAnalytics, resolveCurrentSprints, type SprintClock, type OpCtx } from "@nod/core";
import type { Hono } from "hono";
import { paramInt, queryFlag } from "../input";

export function registerSprintRoutes(app: Hono, me: OpCtx, clock: SprintClock = {}): void {
  app.get("/api/sprints", c => {
    const workspace = c.req.query("workspaceId");
    return c.json(listSprints(me.db,{workspaceId:workspace === undefined ? undefined : paramInt(workspace,"Workspace ID")}));
  });
  app.get("/api/sprints/current", c => {
    const ids = c.req.queries("workspaceId");
    return c.json(resolveCurrentSprints(me.db, {
      clock, workspaceIds: ids?.map(id=>paramInt(id,"Workspace ID")),
      archived: queryFlag(c.req.query("archived"),"archived"),
    }));
  });
  app.get("/api/sprints/:ref/analytics", c => c.json(sprintAnalytics(me.db,c.req.param("ref"),{clock,timezone:c.req.query("tz")})));
  app.get("/api/sprints/:ref", c => c.json(getSprint(me.db,c.req.param("ref"))));
}
