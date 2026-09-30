import {
  addInitiativeProject,
  createInitiative,
  type InitiativeStatus,
  getInitiative,
  listInitiatives,
  type OpCtx,
  removeInitiativeProject,
  updateInitiative,
} from "@nod/core";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { optNullableString, optString, queryFlag, readBody, reqString } from "../input";

// Initiative（#81）。書き手は me 固定。Project・Issue の状態は変えない
export function registerInitiativeRoutes(app: Hono, db: Database, me: OpCtx): void {
  app.get("/api/initiatives", (c) =>
    c.json(listInitiatives(db, { includeClosed: queryFlag(c.req.query("includeClosed"), "includeClosed") })),
  );
  app.get("/api/initiatives/:id", (c) => c.json(getInitiative(db, c.req.param("id"))));

  app.post("/api/initiatives", async (c) => {
    const body = await readBody(c, ["name", "description", "targetDate"]);
    const created = createInitiative(me, {
      name: reqString(body, "name"),
      description: optString(body, "description") || undefined,
      targetDate: optString(body, "targetDate") || undefined,
    });
    return c.json(created, 201);
  });

  app.post("/api/initiatives/:id/update", async (c) => {
    const body = await readBody(c, ["name", "description", "targetDate", "status"]);
    return c.json(
      updateInitiative(me, c.req.param("id"), {
        name: optString(body, "name"),
        description: optNullableString(body, "description"),
        targetDate: optNullableString(body, "targetDate"),
        status: optString(body, "status") as InitiativeStatus | undefined,
      }),
    );
  });

  app.post("/api/initiatives/:id/projects", async (c) => {
    const body = await readBody(c, ["project"]);
    return c.json(addInitiativeProject(me, c.req.param("id"), reqString(body, "project")));
  });

  // :project は Project の名前か ID
  app.delete("/api/initiatives/:id/projects/:project", (c) =>
    c.json(removeInitiativeProject(me, c.req.param("id"), c.req.param("project"))),
  );
}
