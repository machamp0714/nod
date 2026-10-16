import { expect, test } from "bun:test";
import { createIssue, updateIssue } from "@nod/core";
import { call, setup } from "./helpers";

function family() {
  const t = setup();
  const parent = createIssue(t.me, { workspaceId: t.ws.id, title: "親" });
  const child = createIssue(t.me, { workspaceId: t.ws.id, title: "子", parentRef: parent.id });
  updateIssue(t.me, child.id, { status: "done" });
  return { ...t, parent };
}

test("詳細と一覧が completionCandidate を返し、既存の update で完了すると外れる", async () => {
  const { app, parent } = family();
  expect((await call(app, "GET", `/api/issues/${parent.id}`)).json.completionCandidate).toBe(true);
  const list = (await call(app, "GET", "/api/issues")).json.issues;
  expect(list.find((i: { id: string }) => i.id === parent.id).completionCandidate).toBe(true);
  const done = await call(app, "POST", `/api/issues/${parent.id}/update`, { status: "done" });
  expect(done.status).toBe(200);
  expect(done.json).toMatchObject({ status: "done", completionCandidate: false });
});

test("レビュー中の親は既存の approve で完了する", async () => {
  const { app, me, parent } = family();
  updateIssue(me, parent.id, { status: "in_review" });
  const approved = await call(app, "POST", `/api/issues/${parent.id}/approve`, {});
  expect(approved.status).toBe(200);
  expect(approved.json).toMatchObject({ status: "done", completionCandidate: false });
});
