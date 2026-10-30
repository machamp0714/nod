import { expect, test } from "bun:test";
import { answerQuestion, askQuestion, createIssue, updateIssue } from "@nod/core";
import { createApp } from "../src/app";
import { call, setup } from "./helpers";

async function activeSprint() {
  const f = setup();
  const clock = { now: new Date("2026-10-30T03:00:00.000Z") };
  const app = createApp({ db: f.db, sprintClock: clock });
  await call(app, "PUT", `/api/workspaces/${f.ws.key}/scrum`, { expectedVersion: 0, requestKey: "設定", enabled: true, problem: "残件が不明", productGoal: "終了時に確認", priorityRationale: "判断を優先" });
  let sprint = (await call(app, "POST", "/api/sprints", { workspaceKey: f.ws.key, startDate: "2026-10-30", endDate: "2026-10-30", timezone: "Asia/Tokyo", expectedVersion: 0, requestKey: "作成" })).json;
  const issue = createIssue(f.me, { workspaceId: f.ws.id, title: "残件を確認" });
  const added = (await call(app, "POST", `/api/sprints/${sprint.id}/candidates`, { expectedVersion: sprint.version, requestKey: "候補", issueRef: issue.id })).json;
  const proposed = (await call(app, "POST", `/api/sprints/${sprint.id}/plans`, { expectedVersion: added.sprint.version, requestKey: "計画", goal: "残件を確認", verificationMethod: "記録を再取得", items: [{ itemId: added.item.id, contribution: "残件の確認", executionPlan: "終了を記録" }], definitionOfDone: [{ id: "確認", text: "記録を閲覧" }], constraints: { executionScope: "Workspace", maxParallel: 1, notes: "既存権限" }, changeReason: "初期計画" })).json;
  const accepted = (await call(app, "POST", `/api/sprints/${sprint.id}/plans/${proposed.plan.id}/accept`, { expectedVersion: proposed.sprint.version, requestKey: "合意", contentHash: proposed.plan.contentHash })).json;
  sprint = (await call(app, "POST", `/api/sprints/${sprint.id}/activate`, { expectedVersion: accepted.sprint.version, requestKey: "開始" })).json;
  return { ...f, app, clock, sprint, issue, item: added.item };
}

test("期限前の終了を拒否し、期限到来だけでは終了済みにしない", async () => {
  const { db, app, clock, sprint } = await activeSprint();
  try {
    const input = { expectedVersion: sprint.version, requestKey: "終了", reason: "予定期間の終了" };
    expect((await call(app, "GET", `/api/sprints/${sprint.id}`)).json).toMatchObject({ phase: "active", startDate: "2026-10-30", endDate: "2026-10-30", timezone: "Asia/Tokyo", endsAt: "2026-10-30T15:00:00.000Z" });
    clock.now = new Date("2026-10-30T14:59:59.999Z");
    expect(await call(app, "POST", `/api/sprints/${sprint.id}/end`, input)).toMatchObject({ status: 409, json: { error: { code: "SPRINT_NOT_EXPIRED" } } });
    clock.now = new Date("2026-10-30T15:00:00.000Z");
    expect((await call(app, "GET", `/api/sprints/${sprint.id}`)).json.phase).toBe("active");
    expect(await call(app, "POST", `/api/sprints/${sprint.id}/end`, input)).toMatchObject({ status: 200, json: { phase: "ended" } });
  } finally { db.close(); }
});

test("終了時の採択残件と完了済みIssueの未回答質問を保存し、後日の更新から保持する", async () => {
  const { db, app, me, llm, ws, clock, sprint, issue, item } = await activeSprint();
  try {
    const finished = createIssue(me, { workspaceId: ws.id, title: "完了済みにも質問が残る" });
    const canceled = createIssue(me, { workspaceId: ws.id, title: "取りやめた要求" });
    const candidate = createIssue(me, { workspaceId: ws.id, title: "候補のまま" });
    let current = sprint;
    const selected = [item.id];
    for (const extra of [finished, canceled, candidate]) {
      const added = (await call(app, "POST", `/api/sprints/${sprint.id}/candidates`, { expectedVersion: current.version, requestKey: extra.id, issueRef: extra.id })).json;
      current = added.sprint;
      if (extra !== candidate) selected.push(added.item.id);
    }
    const proposed = (await call(app, "POST", `/api/sprints/${sprint.id}/plans`, { expectedVersion: current.version, requestKey: "追加計画", goal: "終了時に確認", verificationMethod: "再取得", items: selected.map(itemId => ({ itemId, contribution: "残件確認", executionPlan: "記録する" })), definitionOfDone: [{ id: "記録", text: "再表示できる" }], constraints: { executionScope: "Workspace", maxParallel: 1, notes: "権限維持" }, changeReason: "対象を追加" })).json;
    current = (await call(app, "POST", `/api/sprints/${sprint.id}/plans/${proposed.plan.id}/accept`, { expectedVersion: proposed.sprint.version, requestKey: "追加合意", contentHash: proposed.plan.contentHash })).json.sprint;
    const openQuestion = askQuestion(llm, issue.id, "何が残ったか").question;
    const finishedQuestion = askQuestion(llm, finished.id, "完了後の判断は必要か").question;
    askQuestion(llm, candidate.id, "候補の質問");
    updateIssue(me, finished.id, { status: "done" });
    updateIssue(me, canceled.id, { status: "canceled" });
    clock.now = new Date("2026-10-30T15:00:00.000Z");
    expect((await call(app, "POST", `/api/sprints/${sprint.id}/end`, { expectedVersion: current.version, requestKey: "終了記録", reason: "予定期間の終了" })).status).toBe(200);
    const record = (await call(app, "GET", `/api/sprints/${sprint.id}`)).json.closureRecord;
    expect(record).toEqual({ kind: "ended", reason: "予定期間の終了", recordedAt: "2026-10-30T15:00:00.000Z", issues: [{ issueId: issue.id, status: "needs_clarification" }], questions: [
      { questionId: openQuestion.id, issueId: issue.id },
      { questionId: finishedQuestion.id, issueId: finished.id },
    ] });
    answerQuestion(me, issue.id, "次期に確認する", { questionId: openQuestion.id });
    answerQuestion(me, finished.id, "判断済み", { questionId: finishedQuestion.id });
    updateIssue(me, issue.id, { status: "done" });
    expect((await call(app, "GET", `/api/sprints/${sprint.id}`)).json.closureRecord).toEqual(record);
  } finally { db.close(); }
});

test("終了の版確認と再送を維持し、終了後の新規着手と自動開始を認めない", async () => {
  const { db, app, clock, sprint, item } = await activeSprint();
  try {
    clock.now = new Date("2026-10-30T15:00:00.000Z");
    const path = `/api/sprints/${sprint.id}`;
    const input = { expectedVersion: sprint.version, requestKey: "一度だけ終了", reason: "予定期間の終了" };
    const before = (await call(app, "GET", path)).json;
    for (const extra of [{ actor: "me" }, { actor: "codex" }]) {
      expect(await call(app, "POST", `${path}/end`, { ...input, ...extra })).toMatchObject({ status: 400, json: { error: { code: "INVALID_ARGS" } } });
    }
    expect(await call(app, "POST", `${path}/end`, { ...input, expectedVersion: 0 })).toMatchObject({ status: 409, json: { error: { code: "STALE_REVISION" } } });
    expect(await call(app, "POST", `${path}/end`, { ...input, reason: " " })).toMatchObject({ status: 400, json: { error: { code: "INVALID_ARGS" } } });
    expect((await call(app, "GET", path)).json).toEqual(before);
    const ended = await call(app, "POST", `${path}/end`, input);
    const saved = (await call(app, "GET", path)).json;
    expect(await call(app, "POST", `${path}/end`, input)).toEqual(ended);
    expect(await call(app, "POST", `${path}/end`, { ...input, reason: "別の理由" })).toMatchObject({ status: 409, json: { error: { code: "IDEMPOTENCY_CONFLICT" } } });
    expect(await call(app, "POST", `${path}/end`, { ...input, requestKey: "別の操作", expectedVersion: ended.json.version })).toMatchObject({ status: 409, json: { error: { code: "INVALID_STATE" } } });
    expect((await call(app, "GET", path)).json).toEqual(saved);
    expect((await call(app, "GET", `${path}/items/${item.id}/eligibility`)).json).toMatchObject({ eligible: false, reason: { code: "SPRINT_NOT_ACTIVE" } });
    expect((await call(app, "GET", "/api/sprints")).json.map((s: any) => s.id)).toEqual([sprint.id]);
    expect((await call(app, "GET", `${path}/execution`)).json.execution).toMatchObject({ session: null, attempts: [], operations: [] });
  } finally { db.close(); }
});

test("終了記録の保存に失敗したら成功を返さず、状態変更も残さない", async () => {
  const { db, app, clock, sprint } = await activeSprint();
  try {
    clock.now = new Date("2026-10-30T15:00:00.000Z");
    const path = `/api/sprints/${sprint.id}`;
    const before = (await call(app, "GET", path)).json;
    // DB境界の書込み拒否で、状態と記録が一緒にロールバックすることをHTTPから確認する。
    db.exec("CREATE TRIGGER 終了記録保存拒否 BEFORE UPDATE OF closure_record ON sprints BEGIN SELECT RAISE(ABORT,'終了記録を保存できません'); END");
    const input = { expectedVersion: sprint.version, requestKey: "失敗後も同じ操作", reason: "予定期間の終了" };
    expect((await call(app, "POST", `${path}/end`, input)).status).toBe(500);
    expect((await call(app, "GET", path)).json).toEqual(before);
    db.exec("DROP TRIGGER 終了記録保存拒否");
    expect(await call(app, "POST", `${path}/end`, input)).toMatchObject({ status: 200, json: { phase: "ended", version: sprint.version + 1 } });
    expect((await call(app, "GET", path)).json.closureRecord).toMatchObject({ reason: "予定期間の終了", recordedAt: "2026-10-30T15:00:00.000Z" });
  } finally { db.close(); }
});

test("中止時の採択残件と完了済みIssueの未回答質問を保存し、後日の更新と再送から保持する", async () => {
  const { db, app, me, llm, ws, clock, sprint, issue, item } = await activeSprint();
  try {
    const finished = createIssue(me, { workspaceId: ws.id, title: "完了済みにも質問が残る" });
    const canceled = createIssue(me, { workspaceId: ws.id, title: "取りやめた要求" });
    const candidate = createIssue(me, { workspaceId: ws.id, title: "候補のまま" });
    let current = sprint;
    const selected = [item.id];
    for (const extra of [finished, canceled, candidate]) {
      const added = (await call(app, "POST", `/api/sprints/${sprint.id}/candidates`, { expectedVersion: current.version, requestKey: extra.id, issueRef: extra.id })).json;
      current = added.sprint;
      if (extra !== candidate) selected.push(added.item.id);
    }
    const proposed = (await call(app, "POST", `/api/sprints/${sprint.id}/plans`, { expectedVersion: current.version, requestKey: "追加計画", goal: "終了時に確認", verificationMethod: "再取得", items: selected.map(itemId => ({ itemId, contribution: "残件確認", executionPlan: "記録する" })), definitionOfDone: [{ id: "記録", text: "再表示できる" }], constraints: { executionScope: "Workspace", maxParallel: 1, notes: "権限維持" }, changeReason: "対象を追加" })).json;
    current = (await call(app, "POST", `/api/sprints/${sprint.id}/plans/${proposed.plan.id}/accept`, { expectedVersion: proposed.sprint.version, requestKey: "追加合意", contentHash: proposed.plan.contentHash })).json.sprint;
    const openQuestion = askQuestion(llm, issue.id, "何が残ったか").question;
    const finishedQuestion = askQuestion(llm, finished.id, "完了後の判断は必要か").question;
    askQuestion(llm, candidate.id, "候補の質問");
    updateIssue(me, finished.id, { status: "done" });
    updateIssue(me, canceled.id, { status: "canceled" });
    const input = { expectedVersion: current.version, requestKey: "中止記録", reason: "優先順位の変更" };
    const stopped = await call(app, "POST", `/api/sprints/${sprint.id}/cancel`, input);
    expect(stopped).toMatchObject({ status: 200, json: { phase: "canceled", cancelReason: "優先順位の変更", canceledAt: "2026-10-30T03:00:00.000Z" } });
    const record = (await call(app, "GET", `/api/sprints/${sprint.id}`)).json.closureRecord;
    expect(record).toEqual({ kind: "canceled", reason: "優先順位の変更", recordedAt: "2026-10-30T03:00:00.000Z", issues: [{ issueId: issue.id, status: "needs_clarification" }], questions: [
      { questionId: openQuestion.id, issueId: issue.id },
      { questionId: finishedQuestion.id, issueId: finished.id },
    ] });
    answerQuestion(me, issue.id, "次期に確認する", { questionId: openQuestion.id });
    answerQuestion(me, finished.id, "判断済み", { questionId: finishedQuestion.id });
    updateIssue(me, issue.id, { status: "done" });
    clock.now = new Date("2026-10-31T03:00:00.000Z");
    expect(await call(app, "POST", `/api/sprints/${sprint.id}/cancel`, input)).toEqual(stopped);
    expect((await call(app, "GET", `/api/sprints/${sprint.id}`)).json.closureRecord).toEqual(record);
  } finally { db.close(); }
});

test("中止の入力・版・人専用操作と再送を維持し、中止後の新規着手と自動開始を認めない", async () => {
  const { db, app, sprint, item } = await activeSprint();
  try {
    const path = `/api/sprints/${sprint.id}`;
    const input = { expectedVersion: sprint.version, requestKey: "一度だけ中止", reason: "優先順位の変更" };
    const before = (await call(app, "GET", path)).json;
    for (const extra of [{ actor: "me" }, { actor: "codex" }]) {
      expect(await call(app, "POST", `${path}/cancel`, { ...input, ...extra })).toMatchObject({ status: 400, json: { error: { code: "INVALID_ARGS" } } });
    }
    expect(await call(app, "POST", `${path}/cancel`, { ...input, expectedVersion: 0 })).toMatchObject({ status: 409, json: { error: { code: "STALE_REVISION" } } });
    expect(await call(app, "POST", `${path}/cancel`, { ...input, reason: " " })).toMatchObject({ status: 400, json: { error: { code: "INVALID_ARGS" } } });
    expect((await call(app, "GET", path)).json).toEqual(before);
    const stopped = await call(app, "POST", `${path}/cancel`, input);
    const saved = (await call(app, "GET", path)).json;
    expect(await call(app, "POST", `${path}/cancel`, input)).toEqual(stopped);
    expect(await call(app, "POST", `${path}/cancel`, { ...input, reason: "別の理由" })).toMatchObject({ status: 409, json: { error: { code: "IDEMPOTENCY_CONFLICT" } } });
    expect(await call(app, "POST", `${path}/cancel`, { ...input, requestKey: "別の操作", expectedVersion: stopped.json.version })).toMatchObject({ status: 409, json: { error: { code: "INVALID_STATE" } } });
    expect((await call(app, "GET", path)).json).toEqual(saved);
    expect((await call(app, "GET", `${path}/items/${item.id}/eligibility`)).json).toMatchObject({ eligible: false, reason: { code: "SPRINT_NOT_ACTIVE" } });
    expect((await call(app, "GET", "/api/sprints")).json.map((s: any) => s.id)).toEqual([sprint.id]);
    expect((await call(app, "GET", `${path}/execution`)).json.execution).toMatchObject({ session: null, attempts: [], operations: [] });
  } finally { db.close(); }
});

test("中止記録の保存に失敗したら成功を返さず、状態変更も残さない", async () => {
  const { db, app, sprint } = await activeSprint();
  try {
    const path = `/api/sprints/${sprint.id}`;
    const before = (await call(app, "GET", path)).json;
    // DB境界の書込み拒否で、状態と記録が一緒にロールバックすることをHTTPから確認する。
    db.exec("CREATE TRIGGER 中止記録保存拒否 BEFORE UPDATE OF closure_record ON sprints BEGIN SELECT RAISE(ABORT,'中止記録を保存できません'); END");
    const input = { expectedVersion: sprint.version, requestKey: "失敗後も同じ操作", reason: "優先順位の変更" };
    expect((await call(app, "POST", `${path}/cancel`, input)).status).toBe(500);
    expect((await call(app, "GET", path)).json).toEqual(before);
    db.exec("DROP TRIGGER 中止記録保存拒否");
    expect(await call(app, "POST", `${path}/cancel`, input)).toMatchObject({ status: 200, json: { phase: "canceled", version: sprint.version + 1 } });
    expect((await call(app, "GET", path)).json.closureRecord).toMatchObject({ reason: "優先順位の変更", recordedAt: "2026-10-30T03:00:00.000Z" });
  } finally { db.close(); }
});
