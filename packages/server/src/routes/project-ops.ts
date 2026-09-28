import { type OpCtx, type ProjectStatus, updateProject } from "@nod/core";
import type { Hono } from "hono";
import { readBody, reqString } from "../input";

export function registerProjectOps(app: Hono, me: OpCtx): void {
  app.post("/api/projects/:id/update", async (c) => {
    const body = await readBody(c, ["status"]);
    // enum の実行時検証は core に集約し、CLI と同じ契約で拒否する。
    const status = reqString(body, "status") as ProjectStatus;
    return c.json(updateProject(me, c.req.param("id"), { status }));
  });
}
