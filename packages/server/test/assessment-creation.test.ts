import { expect, test } from "bun:test";
import { addRecurringIssue, createIssue, getIssue, setWorkspaceSpecAssessment } from "@nod/core";
import { createApp } from "../src/app";
import { call, setup } from "./helpers";

test("HTTPの複製・定期起票・自動化が共通の判定へ接続される", async () => {
  const { db, ws, me } = setup();
  const source = createIssue(me, { workspaceId: ws.id, title: "元" });
  setWorkspaceSpecAssessment(me, ws.key, true);
  let calls = 0;
  const app = createApp({ db, jevClient: async () => {
    calls++; expect(db.inTransaction).toBe(false);
    return { kind: "success", probability: 0.8, model: "jev-1.13.0", inputTokens: 1, elapsedMs: 1 };
  } });
  const copy = await call(app, "POST", `/api/issues/${source.id}/copy`, {});
  expect(copy.status).toBe(201); expect(copy.json.specAssessment.status).toBe("completed");
  addRecurringIssue(me, ws.key, { title: "定期", cadence: "daily", startDate: "2026-01-01", timeZone: "UTC" });
  await call(app, "POST", `/api/workspaces/${ws.key}/recurring/run`, { dryRun: true });
  expect(calls).toBe(1);
  const recurring = await call(app, "POST", `/api/workspaces/${ws.key}/recurring/run`, {});
  expect(getIssue(db, recurring.json.items[0].issueId).labels).toContain("needs-spec");
  addRecurringIssue(me, ws.key, { title: "自動化", cadence: "daily", startDate: "2026-01-01", timeZone: "UTC" });
  await call(app, "POST", `/api/workspaces/${ws.key}/automation/run`, {});
  expect(calls).toBe(2);
  const automation = await call(app, "POST", `/api/workspaces/${ws.key}/automation/run`, { dryRun: false });
  expect(automation.status).toBe(200);
  expect(getIssue(db, automation.json.recurring.items[0].issueId).specAssessment?.status).toBe("completed");
  expect(calls).toBe(3);
});
