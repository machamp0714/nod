import { addProjectUpdate, createMilestone, deleteMilestone, type OpCtx, type PROJECT_HEALTH_CLEAR, type ProjectHealth, type ProjectStatus, updateMilestone, updateProject } from "@nod/core";
import type { Hono } from "hono";
import { optNullableString, optString, paramInt, readBody, reqString } from "../input";

export function registerProjectOps(app: Hono, me: OpCtx): void {
  app.post("/api/projects/:id/update", async (c) => {
    const body = await readBody(c, ["status"]);
    // enum の実行時検証は core に集約し、CLI と同じ契約で拒否する。
    const status = reqString(body, "status") as ProjectStatus;
    return c.json(updateProject(me, c.req.param("id"), { status }));
  });

  // 進捗報告の追記。書き手は me 固定で、Issue・Project の状態は変えない。health は任意（null・省略は健全性なし、"none" は未設定に戻す）
  app.post("/api/projects/:id/reports", async (c) => {
    const body = await readBody(c, ["body", "health"]);
    const health = (optNullableString(body, "health") ?? null) as ProjectHealth | typeof PROJECT_HEALTH_CLEAR | null;
    return c.json(addProjectUpdate(me, c.req.param("id"), reqString(body, "body"), health), 201);
  });

  // Milestone（中間目標）。targetDate は YYYY-MM-DD、null で外す
  app.post("/api/projects/:id/milestones", async (c) => {
    const body = await readBody(c, ["name", "targetDate", "description"]);
    const created = createMilestone(me, c.req.param("id"), {
      name: reqString(body, "name"),
      targetDate: optNullableString(body, "targetDate"),
      description: optNullableString(body, "description"),
    });
    return c.json(created, 201);
  });

  app.post("/api/milestones/:id/update", async (c) => {
    const body = await readBody(c, ["name", "targetDate", "description"]);
    return c.json(
      updateMilestone(me, paramInt(c.req.param("id"), "Milestone の ID "), {
        name: optString(body, "name"),
        targetDate: optNullableString(body, "targetDate"),
        description: optNullableString(body, "description"),
      }),
    );
  });

  app.delete("/api/milestones/:id", (c) => c.json(deleteMilestone(me, paramInt(c.req.param("id"), "Milestone の ID "))));
}
