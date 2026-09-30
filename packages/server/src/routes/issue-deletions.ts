import { deleteIssue, listIssueDeletions, type OpCtx } from "@nod/core";
import type { Hono } from "hono";
import { readBody } from "../input";

// アーカイブ済みの Issue の永久削除（#30）と、Workspace ごとの削除の監査ログ。
// /api/issues/:id/:op より先に登録し、添付の実体を消す場所（attachmentsDir）を渡す
export function registerIssueDeletionRoutes(app: Hono, me: OpCtx, attachmentsDir?: string): void {
  app.post("/api/issues/:id/delete", async (c) => {
    await readBody(c, []);
    return c.json(deleteIssue(me, c.req.param("id"), attachmentsDir));
  });
  app.get("/api/workspaces/:key/issue-deletions", (c) => c.json(listIssueDeletions(me.db, c.req.param("key"))));
}
