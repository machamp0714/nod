import { expect, test } from "bun:test";
import { setup } from "./helpers";
import { createIssue, getIssue } from "../src/ops/issues";
import { setWorkspaceSpecAssessment } from "../src/ops/workspaces";
import { copyIssueWithAssessment, runRecurringIssuesWithAssessment } from "../src/ops/assessed-creation";
import { addRecurringIssue } from "../src/ops/recurring";

test("複製は元の判定を引き継がずtransaction外で新規判定する", async () => {
  const { me, ws, db } = setup();
  const source = createIssue(me, { workspaceId: ws.id, title: "元", description: "本文", labels: ["needs-spec"] });
  setWorkspaceSpecAssessment(me, ws.key, true);
  const copy = await copyIssueWithAssessment(me, source.id, {}, async body => {
    expect(body).toBe("本文");
    expect(db.inTransaction).toBe(false);
    return { kind: "failed", failureKind: "timeout", elapsedMs: 5 };
  });
  expect(copy.specAssessment?.status).toBe("failed");
  expect(copy.labels).toEqual(["needs-spec"]);
  expect(getIssue(db, source.id).specAssessment).toBeNull();
});

test("定期起票はdry-runを判定せず、失敗でも全件保存し重複起票しない", async () => {
  const { me, ws, db } = setup();
  setWorkspaceSpecAssessment(me, ws.key, true);
  for (let i = 0; i < 4; i++) addRecurringIssue(me, ws.key, { title: `定期${i}`, cadence: "daily", startDate: "2026-10-01", timeZone: "UTC" });
  let calls = 0, active = 0, peak = 0;
  const client = async () => {
    expect(db.inTransaction).toBe(false);
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5)); active--;
    return { kind: "failed" as const, failureKind: "timeout" as const, elapsedMs: 5 };
  };
  const opts = { now: new Date("2026-10-10T00:00:00Z") };
  await runRecurringIssuesWithAssessment(me, ws.key, { ...opts, dryRun: true }, client);
  expect(calls).toBe(0);
  const result = await runRecurringIssuesWithAssessment(me, ws.key, opts, client);
  expect(calls).toBe(4); expect(peak).toBeLessThanOrEqual(2);
  expect(result.items).toHaveLength(4);
  for (const item of result.items) expect(getIssue(db, item.issueId!).specAssessment?.status).toBe("failed");
  expect((await runRecurringIssuesWithAssessment(me, ws.key, opts, client)).items).toHaveLength(0);
  expect(calls).toBe(4);
});

test("自動化起票も判定失敗で取り消さず、確認済み発生日の重複を抑止する", async () => {
  const { runAutomationWithAssessment } = await import("../src/ops/assessed-creation");
  const { me, ws, db } = setup();
  setWorkspaceSpecAssessment(me, ws.key, true);
  const rule = addRecurringIssue(me, ws.key, { title: "定期", cadence: "daily", startDate: "2026-10-01", timeZone: "UTC" });
  let calls = 0;
  const client = async () => {
    calls++; expect(db.inTransaction).toBe(false);
    return { kind: "failed" as const, failureKind: "network" as const, elapsedMs: 1 };
  };
  const opts = { evaluatedAt: "2026-10-10T00:00:00Z", targets: { recurring: [{ recurringId: rule.id, occurrence: "2026-10-10" }] } };
  await runAutomationWithAssessment(me, ws.key, { ...opts, dryRun: true }, client);
  expect(calls).toBe(0);
  const result = await runAutomationWithAssessment(me, ws.key, opts, client);
  expect(calls).toBe(1);
  expect(getIssue(db, result.recurring.items[0]!.issueId!).specAssessment?.status).toBe("failed");
  expect((await runAutomationWithAssessment(me, ws.key, opts, client)).recurring.items).toHaveLength(0);
  expect(calls).toBe(1);
});
