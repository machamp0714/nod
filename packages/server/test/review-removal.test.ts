import { expect, test } from "bun:test";
import { createIssue, startIssue } from "@nod/core";
import { call, setup } from "./helpers";

test("レビュー操作の API と自動化設定は撤去され、通常の完了操作を使える", async () => {
  const { app, db, me, ws } = setup();
  try {
    const issue = createIssue(me, { workspaceId: ws.id, title: "実装する" });
    startIssue(me, issue.id);
    for (const op of ["approve", "reject"]) {
      expect((await call(app, "POST", `/api/issues/${issue.id}/${op}`, {})).status).toBe(404);
    }
    for (const key of ["prReview", "commitReview"]) {
      expect((await call(app, "PUT", `/api/workspaces/${ws.key}/automation`, { [key]: true })).status).toBe(400);
    }
    expect((await call(app, "POST", `/api/workspaces/${ws.key}/automation/run`, { targets: { pr_review: [issue.id] } })).status).toBe(400);
    expect((await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "done" })).json.status).toBe("done");
    expect((await call(app, "GET", "/api/inbox")).json).not.toHaveProperty("reviews");
  } finally {
    db.close();
  }
});
