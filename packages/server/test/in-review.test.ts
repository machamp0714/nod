import { expect, test } from "bun:test";
import { createIssue, startIssue } from "@nod/core";
import { createApp } from "../src/app";
import { call, setup } from "./helpers";

test("PRなしでもレビュー中へ移し、取得と絞り込みで同じ状態を確認できる", async () => {
  const { app, db, me, ws } = setup();
  try {
    const issue = createIssue(me, { workspaceId: ws.id, title: "レビューに提出する" });
    startIssue(me, issue.id);
    const updated = await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "in_review" });
    expect(updated.status).toBe(200);
    expect(updated.json.status).toBe("in_review");
    const detail = await call(app, "GET", `/api/issues/${issue.id}`);
    expect(detail.json.status).toBe("in_review");
    expect(detail.json.activity).toContainEqual(expect.objectContaining({
      kind: "event", type: "status_changed", data: expect.objectContaining({ to: "in_review", review_semantics: "pr_review" }),
    }));
    const list = await call(app, "GET", "/api/issues?status=in_review");
    expect(list.status).toBe(200);
    expect(list.json.issues.map((item: { id: string }) => item.id)).toEqual([issue.id]);
  } finally {
    db.close();
  }
});

test("レビュー中の表示名と出入りの禁止ルールを保存し、拒否時は状態を保つ", async () => {
  const { app, db, me, ws } = setup();
  try {
    const issue = createIssue(me, { workspaceId: ws.id, title: "レビュー制御" });
    const base = `/api/workspaces/${ws.key}`;
    expect((await call(app, "PUT", `${base}/status-names`, { names: { in_review: "レビュー中" } })).status).toBe(200);
    expect((await call(app, "GET", `${base}/status-names`)).json.names).toEqual({ in_review: "レビュー中" });
    const forbidden = [{ from: "todo", to: "in_review" }, { from: "in_review", to: "done" }];
    expect((await call(app, "PUT", `${base}/transitions`, { forbidden })).status).toBe(200);
    expect((await call(app, "GET", `${base}/transitions`)).json.forbidden).toEqual(forbidden);
    const denied = await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "in_review" });
    expect(denied.status).toBe(409);
    expect(denied.json.error.code).toBe("TRANSITION_NOT_ALLOWED");
    expect(denied.json.error.message).toContain("Todo → レビュー中");
    expect((await call(app, "GET", `/api/issues/${issue.id}`)).json.status).toBe("todo");
    await call(app, "PUT", `${base}/transitions`, { forbidden: forbidden.slice(1) });
    expect((await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "in_review" })).status).toBe(200);
    expect((await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "done" })).json.error.code).toBe("TRANSITION_NOT_ALLOWED");
    expect((await call(app, "GET", `/api/issues/${issue.id}`)).json.status).toBe("in_review");
    await call(app, "POST", `/api/issues/${issue.id}/archive`, {});
    expect((await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "todo" })).json.error.code).toBe("ISSUE_ARCHIVED");
  } finally {
    db.close();
  }
});


test("draft PRを紐付けて取得しても状態は変わらず、明示操作でレビュー中にできる", async () => {
  const { db, me, ws } = setup();
  const url = "https://github.com/example/nod/pull/1";
  const app = createApp({ db, ghRunner: async () => ({ kind: "exited", exitCode: 0, stderr: "", stdout: JSON.stringify({ number: 1, title: "変更", url, state: "OPEN", isDraft: true, reviewDecision: "REVIEW_REQUIRED", mergedAt: null, statusCheckRollup: [] }) }) });
  try {
    const issue = createIssue(me, { workspaceId: ws.id, title: "draftを提出" });
    startIssue(me, issue.id);
    expect((await call(app, "POST", `/api/issues/${issue.id}/link-pr`, { url })).json.status).toBe("in_progress");
    expect((await call(app, "POST", `/api/issues/${issue.id}/pr-status/refresh`)).json.status.isDraft).toBe(true);
    expect((await call(app, "GET", `/api/issues/${issue.id}`)).json.status).toBe("in_progress");
    expect((await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "in_review" })).json.status).toBe("in_review");
    await call(app, "POST", `/api/issues/${issue.id}/pr-status/refresh`);
    expect((await call(app, "GET", `/api/issues/${issue.id}`)).json.status).toBe("in_review");
  } finally {
    db.close();
  }
});
