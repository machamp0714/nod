import { expect, test } from "bun:test";
import { createIssue, findWorkspace, setWorkspaceSpecAssessment, type JevClient } from "@nod/core";
import { createApp } from "../src/app";
import { call, setup } from "./helpers";

test("Web設定はCLIと共有され、不正要求と外部からの変更を拒む", async () => {
  const { db, ws } = setup();
  const app = createApp({ db, jevClient: async () => { throw new Error("呼ばない"); } });
  const path = `/api/workspaces/${ws.key}/spec-assessment`;
  expect((await call(app, "PUT", path, { enabled: true })).status).toBe(200);
  expect(findWorkspace(db, ws.key)?.specAssessmentEnabled).toBe(true);
  for (const body of [{ enabled: "true" }, {}, { enabled: false, actor: "codex" }]) {
    expect((await call(app, "PUT", path, body)).status).toBe(400);
  }
  expect((await app.request(path, { method: "PUT", headers: { Origin: "https://example.com", "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status).toBe(403);
  expect(findWorkspace(db, ws.key)?.specAssessmentEnabled).toBe(true);
  expect((await call(app, "PUT", path, { enabled: false })).json.specAssessmentEnabled).toBe(false);
});

test("HTTPから失敗を表示し再試行でき、完了後の再評価はラベルを変更しない", async () => {
  const { db, me, ws } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "変更", description: "本文" });
  setWorkspaceSpecAssessment(me, ws.key, true);
  let attempt = 0;
  const client: JevClient = async () => ++attempt === 1
    ? { kind: "failed", failureKind: "timeout", elapsedMs: 5000 }
    : { kind: "success", probability: 0.9, model: "jev-test", inputTokens: 20, elapsedMs: 1 };
  const app = createApp({ db, jevClient: client });
  const path = `/api/issues/${issue.id}/assess-spec`;
  expect((await call(app, "POST", path, {})).json.specAssessment).toMatchObject({ status: "failed", failureKind: "timeout" });
  expect((await call(app, "POST", path, {})).json.labels).toContain("needs-spec");
  await call(app, "POST", `/api/issues/${issue.id}/update`, { removeLabels: ["needs-spec"] });
  const result = await call(app, "POST", path, {});
  expect(result.json.specAssessment.recordOnly).toBe(true);
  expect(result.json.labels).not.toContain("needs-spec");
  expect(result.json.specAssessment.history).toHaveLength(2);
  expect((await call(app, "POST", path, { actor: "me" })).status).toBe(400);
  await call(app, "PUT", `/api/workspaces/${ws.key}/spec-assessment`, { enabled: false });
  expect((await call(app, "POST", path, {})).status).toBe(400);
  expect(attempt).toBe(3);
});
