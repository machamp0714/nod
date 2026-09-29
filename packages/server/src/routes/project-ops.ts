import { addProjectUpdate, type OpCtx, type ProjectStatus, updateProject } from "@nod/core";
import type { Hono } from "hono";
import { readBody, reqString } from "../input";

export function registerProjectOps(app: Hono, me: OpCtx): void {
  app.post("/api/projects/:id/update", async (c) => {
    const body = await readBody(c, ["status"]);
    // enum の実行時検証は core に集約し、CLI と同じ契約で拒否する。
    const status = reqString(body, "status") as ProjectStatus;
    return c.json(updateProject(me, c.req.param("id"), { status }));
  });

  // 進捗報告の追記。書き手は me 固定で、Issue・Project の状態は変えない
  app.post("/api/projects/:id/reports", async (c) => {
    const body = await readBody(c, ["body"]);
    return c.json(addProjectUpdate(me, c.req.param("id"), reqString(body, "body")), 201);
  });
}
