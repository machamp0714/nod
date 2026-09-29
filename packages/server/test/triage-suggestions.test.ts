import { expect, test } from "bun:test";
import { createIssue, getIssue } from "@nod/core";
import { call, setup } from "./helpers";

test("GET /api/triage/:id/suggestions は根拠つきの候補を返し、DBを変えない。Triage以外は409相当のエラー", async () => {
  const { db, app, ws, me, llm } = setup();
  const original = createIssue(me, { workspaceId: ws.id, title: "検索結果のページングがずれる", labels: ["search"] });
  const triage = createIssue(llm, { workspaceId: ws.id, title: "検索結果のページングがずれる" });
  const before = db.serialize();
  const r = await call(app, "GET", `/api/triage/${triage.id}/suggestions`);
  expect(r.status).toBe(200);
  expect(r.json.issueId).toBe(triage.id);
  expect(r.json.duplicates.map((d: { id: string }) => d.id)).toEqual([original.id]);
  expect(r.json.labels).toEqual([{ label: "search", reasons: [{ kind: "similar", issues: [original.id] }] }]);
  expect(r.json.assignees).toEqual([]);
  expect(db.serialize()).toEqual(before);
  const notTriage = await call(app, "GET", `/api/triage/${original.id}/suggestions`);
  expect(notTriage.json.error.code).toBe("NOT_IN_TRIAGE");
  expect((await call(app, "GET", "/api/triage/API-999/suggestions")).status).toBe(404);
  db.close();
});

test("accept は assignee を受け取り、受け入れと同時に担当を設定する", async () => {
  const { db, app, ws, llm } = setup();
  const i = createIssue(llm, { workspaceId: ws.id, title: "判断" });
  expect((await call(app, "POST", `/api/issues/${i.id}/accept`, { assignee: 5 })).status).toBe(400);
  expect(getIssue(db, i.id)).toMatchObject({ status: "triage", assignee: null });
  const r = await call(app, "POST", `/api/issues/${i.id}/accept`, { assignee: "codex" });
  expect(r.json).toMatchObject({ status: "todo", assignee: "codex" });
  db.close();
});
