import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { archiveIssue, askQuestion, createIssue, deleteIssue, initWorkspace, openDb, removeWorkspace, updateIssue } from "@nod/core";
import { legacySprintFixture } from "../../core/test/fixtures/sprint";
import { createApp } from "../src/app";
import { call, setup, tempDir } from "./helpers";

const plan = (version: number, requestKey: string, itemIds: string[]) => ({
  expectedVersion: version, requestKey, goal: "差し込みを進める", verificationMethod: "再取得で確認",
  items: itemIds.map(itemId => ({ itemId, contribution: "範囲を確定", executionPlan: "順に進める" })),
  definitionOfDone: [{ id: "確認", text: "所属を確認" }], constraints: { executionScope: "Workspace", notes: "既存権限" }, changeReason: requestKey,
});

async function configured() {
  const f = setup();
  const clock = { now: new Date("2026-10-30T03:00:00.000Z") };
  const app = createApp({ db: f.db, sprintClock: clock });
  await call(app, "PUT", `/api/workspaces/${f.ws.key}/scrum`, { expectedVersion: 0, requestKey: "設定", enabled: true, problem: "追加に承認が要る", productGoal: "すぐ所属させる", priorityRationale: "差し込みを優先" });
  const draft = (await call(app, "POST", "/api/sprints", { workspaceKey: f.ws.key, startDate: "2026-10-30", endDate: "2026-10-30", timezone: "Asia/Tokyo", expectedVersion: 0, requestKey: "作成" })).json;
  return { ...f, app, clock, draft };
}

// 計画・合意・採用中の計画・版は、追加の前後で変わらないことを公開の読み出しで確かめる。
async function planState(app: ReturnType<typeof createApp>, sprintId: string) {
  const detail = (await call(app, "GET", `/api/sprints/${sprintId}`)).json;
  const plans = (await call(app, "GET", `/api/sprints/${sprintId}/plans`)).json;
  return { version: detail.version, adoptedPlanId: detail.adoptedPlanId, phase: detail.phase, goal: detail.goal, definitionOfDone: detail.definitionOfDone,
    plans: plans.map((p: any) => [p.id, p.revision, p.contentHash, p.agreedBy, p.agreedAt, p.agreedHash, p.agreementSource]) };
}

test("計画が無いdraftへissueRefだけで追加し、計画を作らずに所属させて再取得でも保つ", async () => {
  const { db, app, ws, me, draft } = await configured();
  try {
    const issue = createIssue(me, { workspaceId: ws.id, title: "差し込み" });
    const before = await planState(app, draft.id);
    const added = await call(app, "POST", `/api/sprints/${draft.id}/issues`, { issueRef: issue.id });
    expect(added.status).toBe(200);
    expect(added.json).toMatchObject({ added: true, sprint: { id: draft.id, version: draft.version },
      item: { sprintId: draft.id, sourceIssueKey: issue.id, origin: "candidate", addedBy: "me", addedAt: expect.any(String), member: true, association: "added",
        snapshot: { issue: { title: "差し込み" } } } });
    expect(await planState(app, draft.id)).toEqual(before);
    expect(before.plans).toEqual([]);
    const detail = (await call(app, "GET", `/api/sprints/${draft.id}`)).json;
    expect(detail.items).toEqual([added.json.item]);
    expect((await call(app, "GET", `/api/issues?sprint=${draft.id}`)).json.issues.map((i: any) => i.id)).toEqual([issue.id]);
    expect((await call(app, "GET", `/api/issues?sprint=none`)).json.issues.map((i: any) => i.id)).not.toContain(issue.id);
    expect((await call(app, "GET", `/api/issues/${issue.id}`)).json.sprints).toEqual([{ id: draft.id, number: draft.number, name: draft.name, workspaceId: ws.id, phase: "draft", association: "added", inAdoptedPlan: false }]);
  } finally { db.close(); }
});

// 旧候補（追加の記録が無いitem）。公開の操作では作れないので、DBへ列名付きで直接入れる。
function legacyCandidate(db: import("bun:sqlite").Database, sprintId: string, issueRef: string): string {
  const row = db.query("SELECT i.id FROM issues i JOIN workspaces w ON w.id=i.workspace_id WHERE w.key || '-' || i.number=?").get(issueRef) as { id: number };
  const id = crypto.randomUUID();
  db.query("INSERT INTO sprint_items(id,sprint_id,issue_id,source_issue_key,snapshot,origin) VALUES(?,?,?,?,?,'candidate')")
    .run(id, sprintId, row.id, issueRef, JSON.stringify({ schemaVersion: 1, capturedAt: "2026-10-01T00:00:00.000Z", statusBasis: "candidate_snapshot", labels: [], project: null, workspace: {}, issue: { id: row.id, title: "旧候補", description: null, status: "todo" } }));
  return id;
}
const sprintAdded = (detail: any) => detail.activity.filter((a: any) => a.kind === "event" && a.type === "sprint_added");
// 追加の時刻とActivityの時刻は別々に採るので同値を求めない。Activityが1件で、時刻が有効な日時であることを確かめる。
async function oneSprintAdded(app: ReturnType<typeof createApp>, issueId: string, sprint: { id: string; number: number; name: string }) {
  const events = sprintAdded((await call(app, "GET", `/api/issues/${issueId}`)).json);
  expect(events).toEqual([{ kind: "event", at: expect.any(String), actor: "me", type: "sprint_added", data: { sprintId: sprint.id, sprintNumber: sprint.number, sprintName: sprint.name } }]);
  expect(Number.isNaN(Date.parse(events[0].at))).toBe(false);
  return events;
}
const ids = (res: { json: any }) => res.json.issues.map((i: any) => i.id);

test("合意済み計画のあるreadyへ、新規・旧候補・計画のitemを追加しても計画と合意を変えず、再追加は重複しない", async () => {
  const { db, app, ws, me, draft } = await configured();
  try {
    const planned = createIssue(me, { workspaceId: ws.id, title: "計画で採択" });
    const legacy = createIssue(me, { workspaceId: ws.id, title: "旧候補" });
    const extra = createIssue(me, { workspaceId: ws.id, title: "計画外の追加" });
    const plannedItem = legacyCandidate(db, draft.id, planned.id);
    const legacyItem = legacyCandidate(db, draft.id, legacy.id);
    const proposed = (await call(app, "POST", `/api/sprints/${draft.id}/plans`, plan(draft.version, "計画", [plannedItem]))).json;
    const ready = (await call(app, "POST", `/api/sprints/${draft.id}/plans/${proposed.plan.id}/accept`, { expectedVersion: proposed.sprint.version, requestKey: "合意", contentHash: proposed.plan.contentHash })).json.sprint;
    expect(ready.phase).toBe("ready");
    const items = async () => (await call(app, "GET", `/api/sprints/${draft.id}`)).json.items.map((i: any) => [i.sourceIssueKey, i.member, i.association, i.addedBy]);
    expect(await items()).toEqual([[planned.id, true, "adopted", null], [legacy.id, false, null, null]].sort());
    expect(ids(await call(app, "GET", `/api/issues?sprint=none`))).toContain(legacy.id);
    const before = await planState(app, draft.id);

    for (const [issue, itemId] of [[planned, plannedItem], [legacy, legacyItem], [extra, undefined]] as const) {
      const added = await call(app, "POST", `/api/sprints/${draft.number}/issues`, { issueRef: issue.id });
      expect(added).toMatchObject({ status: 200, json: { added: true, sprint: { id: draft.id, version: ready.version }, item: { sourceIssueKey: issue.id, addedBy: "me", member: true, association: "added" } } });
      if (itemId) expect(added.json.item.id).toBe(itemId);
      const activity = await oneSprintAdded(app, issue.id, draft);
      const again = await call(app, "POST", `/api/sprints/${draft.id}/issues`, { issueRef: issue.id });
      expect(again).toEqual({ status: 200, json: { ...added.json, added: false } });
      expect(await oneSprintAdded(app, issue.id, draft)).toEqual(activity);
    }
    expect(await planState(app, draft.id)).toEqual(before);
    expect(ids(await call(app, "GET", `/api/issues?sprint=${draft.id}`)).sort()).toEqual([planned.id, legacy.id, extra.id].sort());
    expect(ids(await call(app, "GET", `/api/issues?sprint=none`))).not.toContain(legacy.id);

    // 追加の記録がある計画のitemは、それを含まない計画を人が合意しても所属に残る。追加したitemも計画で選べる。
    const extraItem = (await call(app, "GET", `/api/sprints/${draft.id}`)).json.items.find((i: any) => i.sourceIssueKey === extra.id).id;
    const revised = (await call(app, "POST", `/api/sprints/${draft.id}/plans`, plan(ready.version, "計画外を採択", [extraItem]))).json;
    expect(revised.plan.content.items.map((i: any) => i.itemId)).toEqual([extraItem]);
    const accepted = await call(app, "POST", `/api/sprints/${draft.id}/plans/${revised.plan.id}/accept`, { expectedVersion: revised.sprint.version, requestKey: "再合意", contentHash: revised.plan.contentHash });
    expect(accepted.json.sprint.adoptedPlanId).toBe(revised.plan.id);
    expect((await call(app, "GET", `/api/issues/${planned.id}`)).json.sprints.map((s: any) => [s.id, s.association])).toEqual([[draft.id, "added"]]);
    expect(ids(await call(app, "GET", `/api/issues?sprint=${draft.id}`)).sort()).toEqual([planned.id, legacy.id, extra.id].sort());
  } finally { db.close(); }
});

test("追加の時刻とActivityの時刻がミリ秒の境界をまたいでも、追加の結果とActivityを確かめられる", async () => {
  const { db, app, ws, me, draft } = await configured();
  // 時刻を文字列にするたびに1ミリ秒進め、追加の時刻とActivityの時刻が必ず異なる状況を作る。
  const toISOString = Date.prototype.toISOString;
  let tick = 0;
  const clock = spyOn(Date.prototype, "toISOString").mockImplementation(function (this: Date) { return toISOString.call(new Date(this.getTime() + tick++)); });
  try {
    const issue = createIssue(me, { workspaceId: ws.id, title: "境界をまたぐ追加" });
    const added = await call(app, "POST", `/api/sprints/${draft.id}/issues`, { issueRef: issue.id });
    expect(added.json).toMatchObject({ added: true, item: { sourceIssueKey: issue.id, addedAt: expect.any(String) } });
    const activity = await oneSprintAdded(app, issue.id, draft);
    expect(activity[0].at).not.toBe(added.json.item.addedAt);
    const again = await call(app, "POST", `/api/sprints/${draft.id}/issues`, { issueRef: issue.id });
    expect(again).toEqual({ status: 200, json: { ...added.json, added: false } });
    expect(await oneSprintAdded(app, issue.id, draft)).toEqual(activity);
  } finally { clock.mockRestore(); db.close(); }
});

for (const closing of ["end", "cancel"] as const) {
  test(`activeへの差し込みを絞り込み・詳細・分析・${closing === "end" ? "終了" : "中止"}の残件記録が所属として読み、閉じた後の再送を拒否する`, async () => {
    const { db, app, ws, me, llm, clock, draft } = await configured();
    try {
      const planned = createIssue(me, { workspaceId: ws.id, title: "計画の仕事" });
      const first = (await call(app, "POST", `/api/sprints/${draft.id}/issues`, { issueRef: planned.id })).json;
      const proposed = (await call(app, "POST", `/api/sprints/${draft.id}/plans`, plan(first.sprint.version, "計画", [first.item.id]))).json;
      const ready = (await call(app, "POST", `/api/sprints/${draft.id}/plans/${proposed.plan.id}/accept`, { expectedVersion: proposed.sprint.version, requestKey: "合意", contentHash: proposed.plan.contentHash })).json.sprint;
      const active = (await call(app, "POST", `/api/sprints/${draft.id}/activate`, { expectedVersion: ready.version, requestKey: "開始" })).json;
      expect(active.phase).toBe("active");
      const extra = createIssue(me, { workspaceId: ws.id, title: "差し込み" });
      const done = createIssue(me, { workspaceId: ws.id, title: "差し込んで完了" });
      const legacy = createIssue(me, { workspaceId: ws.id, title: "旧候補" });
      const outside = createIssue(me, { workspaceId: ws.id, title: "所属外" });
      legacyCandidate(db, draft.id, legacy.id);
      const before = await planState(app, draft.id);
      for (const issue of [extra, done]) expect((await call(app, "POST", `/api/sprints/${draft.id}/issues`, { issueRef: issue.id })).json).toMatchObject({ added: true, sprint: { version: active.version } });
      expect(await planState(app, draft.id)).toEqual(before);
      // 状態・質問は追加を制限しない。
      const question = askQuestion(llm, extra.id, "差し込みの範囲は").question;
      askQuestion(llm, legacy.id, "旧候補の質問");
      updateIssue(me, done.id, { status: "done" });

      const members = [planned.id, extra.id, done.id].sort();
      expect(ids(await call(app, "GET", `/api/issues?sprint=${draft.id}`)).sort()).toEqual(members);
      expect(ids(await call(app, "GET", `/api/issues?sprint=${draft.number}`)).sort()).toEqual(members);
      expect(ids(await call(app, "GET", `/api/issues?sprint=current`)).sort()).toEqual(members);
      expect((await call(app, "GET", `/api/sprints/current`)).json.issues.map((i: any) => i.id).sort()).toEqual(members);
      expect(ids(await call(app, "GET", `/api/issues?sprint=none`)).sort()).toEqual([legacy.id, outside.id].sort());
      expect((await call(app, "GET", `/api/issues/${extra.id}`)).json.sprints).toEqual([{ id: draft.id, number: draft.number, name: draft.name, workspaceId: ws.id, phase: "active", association: "added", inAdoptedPlan: false }]);
      expect((await call(app, "GET", `/api/sprints/${draft.id}`)).json.items.map((i: any) => [i.sourceIssueKey, i.association]).sort())
        .toEqual([[planned.id, "added"], [extra.id, "added"], [done.id, "added"], [legacy.id, null]].sort());
      expect((await call(app, "GET", `/api/sprints/${draft.id}/analytics`)).json).toMatchObject({ statusBasis: "live_membership", scope: 3, completed: 1 });

      if (closing === "end") clock.now = new Date("2026-10-30T15:00:00.000Z");
      const current = (await call(app, "GET", `/api/sprints/${draft.id}`)).json;
      expect((await call(app, "POST", `/api/sprints/${draft.id}/${closing}`, { expectedVersion: current.version, requestKey: closing, reason: "区切り" })).status).toBe(200);
      const record = (await call(app, "GET", `/api/sprints/${draft.id}`)).json.closureRecord;
      expect(record).toMatchObject({ kind: closing === "end" ? "ended" : "canceled",
        issues: [{ issueId: planned.id, status: "todo" }, { issueId: extra.id, status: "needs_clarification" }],
        questions: [{ questionId: question.id, issueId: extra.id }] });
      const after = (await call(app, "GET", `/api/sprints/${draft.id}`)).json;
      for (const issue of [extra, outside]) {
        expect(await call(app, "POST", `/api/sprints/${draft.id}/issues`, { issueRef: issue.id })).toMatchObject({ status: 409, json: { error: { code: "INVALID_STATE" } } });
      }
      expect((await call(app, "GET", `/api/sprints/${draft.id}`)).json).toEqual(after);
    } finally { db.close(); }
  });
}

test("追加できないSprint・Issue・入力を理由つきで拒否し、何も書かない", async () => {
  const { db, app, ws, me, draft } = await configured();
  try {
    const issue = createIssue(me, { workspaceId: ws.id, title: "追加する" });
    const path = `/api/sprints/${draft.id}/issues`;
    for (const body of [{ issueRef: issue.id, actor: "codex" }, { issueRef: issue.id, expectedVersion: draft.version }, { issueRef: issue.id, requestKey: "追加" }, {}, { issueRef: "" }, { issueRef: 1 }]) {
      expect(await call(app, "POST", path, body)).toMatchObject({ status: 400, json: { error: { code: "INVALID_ARGS" } } });
    }
    expect(await call(app, "POST", path, { issueRef: "API-999" })).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    for (const ref of ["current", "none", "999", crypto.randomUUID()]) {
      expect(await call(app, "POST", `/api/sprints/${ref}/issues`, { issueRef: issue.id })).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    }
    expect((await call(app, "GET", `/api/sprints/${draft.id}`)).json.items).toEqual([]);

    const other = initWorkspace(db, { path: "/tmp/repos/other-ws" }).workspace;
    const foreign = createIssue(me, { workspaceId: other.id, title: "別Workspace" });
    expect(await call(app, "POST", path, { issueRef: foreign.id })).toMatchObject({ status: 400, json: { error: { code: "INVALID_ARGS" } } });

    // 追加済みでも、アーカイブ後の再送は今の条件で拒否する。
    expect((await call(app, "POST", path, { issueRef: issue.id })).json.added).toBe(true);
    archiveIssue(me, issue.id);
    const archived = createIssue(me, { workspaceId: ws.id, title: "アーカイブ済み" });
    archiveIssue(me, archived.id);
    for (const ref of [issue.id, archived.id]) {
      expect(await call(app, "POST", path, { issueRef: ref })).toMatchObject({ status: 409, json: { error: { code: "ISSUE_ARCHIVED" } } });
    }

    // 削除された元Issueの番号が再利用されても、旧itemを新しいIssueへつながない。
    const removed = createIssue(me, { workspaceId: ws.id, title: "削除する" });
    expect((await call(app, "POST", path, { issueRef: removed.id })).json.added).toBe(true);
    archiveIssue(me, removed.id); deleteIssue(me, removed.id);
    db.query("UPDATE workspaces SET next_number=? WHERE id=?").run(removed.number, ws.id);
    const reused = createIssue(me, { workspaceId: ws.id, title: "番号の再利用" });
    expect(reused.id).toBe(removed.id);
    expect(await call(app, "POST", path, { issueRef: reused.id })).toMatchObject({ status: 409, json: { error: { code: "TARGET_CHANGED" } } });
    expect((await call(app, "GET", `/api/issues/${reused.id}`)).json.sprints).toEqual([]);

    // Workspaceを削除したSprintへの追加は拒否する。
    removeWorkspace(db, ws.key);
    expect(await call(app, "POST", path, { issueRef: foreign.id })).toMatchObject({ status: 409, json: { error: { code: "INVALID_STATE" } } });
  } finally { db.close(); }
});

test("移行した履歴のSprintへの追加を拒否する", async () => {
  const path = join(tempDir(), "nod.db"); legacySprintFixture(path);
  const db = openDb(path); const app = createApp({ db });
  try {
    const before = (await call(app, "GET", "/api/sprints/1")).json;
    expect(await call(app, "POST", "/api/sprints/1/issues", { issueRef: "AAA-2" })).toMatchObject({ status: 409, json: { error: { code: "INVALID_STATE" } } });
    expect((await call(app, "GET", "/api/sprints/1")).json).toEqual(before);
    expect(before.items.map((i: any) => [i.sourceIssueKey, i.member, i.association, i.addedBy, i.addedAt])).toEqual([["AAA-1", true, "imported", null, null], ["BBB-1", true, "imported", null, null]]);
  } finally { db.close(); }
});
