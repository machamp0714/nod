import { expect, test } from "bun:test";
import { join } from "node:path";
import { archiveIssue, askQuestion, createIssue, deleteIssue, HUMAN_ACTOR, initWorkspace, openDb, removeWorkspace } from "@nod/core";
import { legacySprintFixture } from "../../core/test/fixtures/sprint";
import { createApp } from "../src/app";
import { call, setup, tempDir } from "./helpers";

const plan = (version: number, requestKey: string, itemIds: string[]) => ({
  expectedVersion: version, requestKey, goal: "所属を整理する", verificationMethod: "再取得で確認",
  items: itemIds.map(itemId => ({ itemId, contribution: "範囲を確定", executionPlan: "順に進める" })),
  definitionOfDone: [{ id: "確認", text: "所属を確認" }], constraints: { executionScope: "Workspace", notes: "既存権限" }, changeReason: requestKey,
});
type App = ReturnType<typeof createApp>;

// 旧候補（追加の記録が無いitem）。公開の操作では採択だけのitemを作れないので、DBへ列名付きで直接入れる。
function legacyCandidate(db: import("bun:sqlite").Database, sprintId: string, issueRef: string): string {
  const row = db.query("SELECT i.id FROM issues i JOIN workspaces w ON w.id=i.workspace_id WHERE w.key || '-' || i.number=?").get(issueRef) as { id: number };
  const id = crypto.randomUUID();
  db.query("INSERT INTO sprint_items(id,sprint_id,issue_id,source_issue_key,snapshot,origin) VALUES(?,?,?,?,?,'candidate')")
    .run(id, sprintId, row.id, issueRef, JSON.stringify({ schemaVersion: 1, capturedAt: "2026-10-01T00:00:00.000Z", statusBasis: "candidate_snapshot", labels: [], project: null, workspace: {}, issue: { id: row.id, title: "旧候補", description: null, status: "todo" } }));
  return id;
}

// 移行した履歴（Sprint 1〜4、AAA-1は Sprint 1 の所属）を持つDB。Workspace AAAを使う。
function legacySetup() {
  const path = join(tempDir(), "nod.db"); legacySprintFixture(path);
  const db = openDb(path);
  return { db, ws: { id: 1, key: "AAA" }, me: { db, actor: HUMAN_ACTOR }, llm: { db, actor: "claude-code" } };
}

async function configured(legacy = false) {
  const f = legacy ? legacySetup() : setup();
  const clock = { now: new Date("2026-10-30T03:00:00.000Z") };
  const app = createApp({ db: f.db, sprintClock: clock });
  await call(app, "PUT", `/api/workspaces/${f.ws.key}/scrum`, { expectedVersion: 0, requestKey: "設定", enabled: true, problem: "所属を画面で変えられない", productGoal: "Issue詳細で所属を変える", priorityRationale: "移動を優先" });
  const create = async (date: string) => (await call(app, "POST", "/api/sprints", { workspaceKey: f.ws.key, startDate: date, endDate: date, timezone: "Asia/Tokyo", expectedVersion: 0, requestKey: `作成${date}` })).json;
  // 採択だけで所属するitemを持つ、人が合意した計画のSprint。activeなら開始する。
  const agreed = async (date: string, adopted: string[], phase: "ready" | "active") => {
    const created = await create(date);
    const proposed = (await call(app, "POST", `/api/sprints/${created.id}/plans`, plan(created.version, `計画${date}`, adopted.map(ref => legacyCandidate(f.db, created.id, ref))))).json;
    let sprint = (await call(app, "POST", `/api/sprints/${created.id}/plans/${proposed.plan.id}/accept`, { expectedVersion: proposed.sprint.version, requestKey: `合意${date}`, contentHash: proposed.plan.contentHash })).json.sprint;
    if (phase === "active") sprint = (await call(app, "POST", `/api/sprints/${created.id}/activate`, { expectedVersion: sprint.version, requestKey: `開始${date}` })).json;
    expect(sprint.phase).toBe(phase);
    return sprint;
  };
  return { ...f, app, clock, create, agreed };
}

// 計画・合意・採用中の計画・版は、操作の前後で変わらないことを公開の読み出しで確かめる。
async function planState(app: App, sprintId: string) {
  const detail = (await call(app, "GET", `/api/sprints/${sprintId}`)).json;
  const plans = (await call(app, "GET", `/api/sprints/${sprintId}/plans`)).json;
  return { version: detail.version, adoptedPlanId: detail.adoptedPlanId, phase: detail.phase, goal: detail.goal, definitionOfDone: detail.definitionOfDone,
    plans: plans.map((p: any) => [p.id, p.revision, p.contentHash, p.agreedBy, p.agreedAt, p.agreedHash, p.agreementSource]) };
}
const refs = async (app: App, issueRef: string) => (await call(app, "GET", `/api/issues/${issueRef}`)).json.sprints
  .map((s: any) => [s.number, s.association, s.inAdoptedPlan]);

test("Sprint参照のinAdoptedPlanは採用中の合意済み計画に含まれるかの真偽値で、未合意の案を数えず計画の交代に従う", async () => {
  const { db, app, ws, me, agreed } = await configured();
  try {
    const adopted = createIssue(me, { workspaceId: ws.id, title: "採択だけ" });
    const both = createIssue(me, { workspaceId: ws.id, title: "追加と採択" });
    const added = createIssue(me, { workspaceId: ws.id, title: "追加だけ" });
    const active = await agreed("2026-10-30", [adopted.id, both.id], "active");
    for (const issue of [both, added]) expect((await call(app, "POST", `/api/sprints/${active.id}/issues`, { issueRef: issue.id })).json.added).toBe(true);
    expect((await call(app, "GET", `/api/issues/${adopted.id}`)).json.sprints).toEqual([
      { id: active.id, number: active.number, name: active.name, workspaceId: ws.id, phase: "active", association: "adopted", inAdoptedPlan: true }]);
    expect(await refs(app, both.id)).toEqual([[active.number, "added", true]]);
    expect(await refs(app, added.id)).toEqual([[active.number, "added", false]]);
    // 一覧の読み出しも同じ値を返す。
    const listed = (await call(app, "GET", `/api/issues?sprint=${active.id}`)).json.issues;
    expect(Object.fromEntries(listed.map((i: any) => [i.id, i.sprints[0].inAdoptedPlan]))).toEqual({ [adopted.id]: true, [both.id]: true, [added.id]: false });

    // 追加だけのitemを含む案は、人が合意するまで採択に数えない。
    const items = (await call(app, "GET", `/api/sprints/${active.id}`)).json.items;
    const addedItem = items.find((i: any) => i.sourceIssueKey === added.id).id;
    const current = (await call(app, "GET", `/api/sprints/${active.id}`)).json;
    const proposed = (await call(app, "POST", `/api/sprints/${active.id}/plans`, plan(current.version, "追加だけを採択", [addedItem]))).json;
    expect(await refs(app, added.id)).toEqual([[active.number, "added", false]]);
    // 合意すると採用中の計画が交代し、前の計画だけにあったitemは採択でなくなる。
    await call(app, "POST", `/api/sprints/${active.id}/plans/${proposed.plan.id}/accept`, { expectedVersion: proposed.sprint.version, requestKey: "交代", contentHash: proposed.plan.contentHash });
    expect(await refs(app, added.id)).toEqual([[active.number, "added", true]]);
    expect(await refs(app, both.id)).toEqual([[active.number, "added", false]]);
    expect(await refs(app, adopted.id)).toEqual([]);
  } finally { db.close(); }
});

const set = (app: App, issueRef: string, sprintRef: string | null) => call(app, "POST", `/api/issues/${issueRef}/sprint`, { sprintRef });
const ids = (res: { json: any }) => res.json.issues.map((i: any) => i.id);
const sprintEvents = (detail: any) => detail.activity.filter((a: any) => a.kind === "event" && ["sprint_added", "sprint_removed"].includes(a.type))
  .map((a: any) => [a.type, a.actor, a.data.sprintNumber]);

test("所属の無いIssueをdraft・ready・activeに設定でき、Issueの参照・Sprint詳細・固定とcurrentの絞り込みに出る", async () => {
  const { db, app, ws, me, create, agreed } = await configured();
  try {
    const active = await agreed("2026-10-30", [createIssue(me, { workspaceId: ws.id, title: "実行中の計画" }).id], "active");
    const ready = await agreed("2026-10-31", [createIssue(me, { workspaceId: ws.id, title: "次の計画" }).id], "ready");
    const draft = await create("2026-11-01");
    const placed: Record<string, string> = {};
    for (const sprint of [draft, ready, active]) {
      const issue = createIssue(me, { workspaceId: ws.id, title: `${sprint.phase}へ入れる` });
      placed[sprint.phase] = issue.id;
      const before = await planState(app, sprint.id);
      const res = await set(app, issue.id, sprint.phase === "ready" ? String(sprint.number) : sprint.id);
      expect(res.status).toBe(200);
      const ref = { id: sprint.id, number: sprint.number, name: sprint.name, workspaceId: ws.id, phase: sprint.phase, association: "added", inAdoptedPlan: false };
      expect(res.json).toMatchObject({ added: true, removedSprintIds: [], issue: { id: issue.id, sprints: [ref] } });
      expect((await call(app, "GET", `/api/issues/${issue.id}`)).json.sprints).toEqual([ref]);
      expect((await call(app, "GET", `/api/sprints/${sprint.id}`)).json.items.find((i: any) => i.sourceIssueKey === issue.id))
        .toMatchObject({ member: true, association: "added", addedBy: "me" });
      expect(ids(await call(app, "GET", `/api/issues?sprint=${sprint.id}`))).toContain(issue.id);
      expect(ids(await call(app, "GET", `/api/issues?sprint=${sprint.number}`))).toContain(issue.id);
      expect(ids(await call(app, "GET", `/api/issues?sprint=none`))).not.toContain(issue.id);
      expect(sprintEvents((await call(app, "GET", `/api/issues/${issue.id}`)).json)).toEqual([["sprint_added", "me", sprint.number]]);
      expect(await planState(app, sprint.id)).toEqual(before);
    }
    const current = ids(await call(app, "GET", `/api/issues?sprint=current`));
    expect(current).toContain(placed.active);
    expect(current).not.toContain(placed.ready);
    expect(current).not.toContain(placed.draft);
  } finally { db.close(); }
});

test("activeからdraftへの設定で元の所属が外れて新しい所属になり、移行履歴と終了したSprintの所属は残る", async () => {
  const { db, app, ws, me, clock, create, agreed } = await configured(true);
  try {
    // 終了したSprintへの追加の所属を作る。
    clock.now = new Date("2026-10-29T03:00:00.000Z");
    const ended = await agreed("2026-10-29", [createIssue(me, { workspaceId: ws.id, title: "前の計画" }).id], "active");
    expect((await call(app, "POST", `/api/sprints/${ended.id}/issues`, { issueRef: "AAA-1" })).json.added).toBe(true);
    clock.now = new Date("2026-10-29T15:00:00.000Z");
    expect((await call(app, "POST", `/api/sprints/${ended.id}/end`, { expectedVersion: ended.version, requestKey: "終了", reason: "期間の終了" })).json.phase).toBe("ended");
    clock.now = new Date("2026-10-30T03:00:00.000Z");
    const active = await agreed("2026-10-30", [createIssue(me, { workspaceId: ws.id, title: "今の計画" }).id], "active");
    const draft = await create("2026-11-01");

    expect((await set(app, "AAA-1", active.id)).json).toMatchObject({ added: true, removedSprintIds: [] });
    const before = [await planState(app, active.id), await planState(app, draft.id)];
    const moved = await set(app, "AAA-1", String(draft.number));
    expect(moved).toMatchObject({ status: 200, json: { added: true, removedSprintIds: [active.id] } });
    const expected = [[1, "imported", false], [ended.number, "added", false], [draft.number, "added", false]];
    expect(moved.json.issue.sprints.map((s: any) => [s.number, s.association, s.inAdoptedPlan])).toEqual(expected);
    expect(await refs(app, "AAA-1")).toEqual(expected);
    expect(ids(await call(app, "GET", `/api/issues?sprint=${active.id}`))).not.toContain("AAA-1");
    expect(ids(await call(app, "GET", `/api/issues?sprint=current`))).not.toContain("AAA-1");
    expect(ids(await call(app, "GET", `/api/issues?sprint=${draft.id}`))).toContain("AAA-1");
    expect(ids(await call(app, "GET", `/api/issues?sprint=${ended.id}`))).toContain("AAA-1");
    // 外したitemは行と写しを残し、所属外として読める。
    expect((await call(app, "GET", `/api/sprints/${active.id}`)).json.items.find((i: any) => i.sourceIssueKey === "AAA-1"))
      .toMatchObject({ member: false, association: null, addedBy: null, addedAt: null, snapshot: { issue: { title: "移行時は完了" } } });
    expect([await planState(app, active.id), await planState(app, draft.id)]).toEqual(before);
    expect(sprintEvents((await call(app, "GET", "/api/issues/AAA-1")).json)).toEqual([
      ["sprint_added", "me", ended.number], ["sprint_added", "me", active.number], ["sprint_removed", "me", active.number], ["sprint_added", "me", draft.number]]);
  } finally { db.close(); }
});

test("nullの設定で開いている所属がすべて外れ、閉じた所属は残り、閉じた所属が無ければnoneの絞り込みに出る", async () => {
  const { db, app, ws, me, create, agreed } = await configured(true);
  try {
    const active = await agreed("2026-10-30", [createIssue(me, { workspaceId: ws.id, title: "今の計画" }).id], "active");
    const draft = await create("2026-11-01");
    const fresh = createIssue(me, { workspaceId: ws.id, title: "履歴の無いIssue" });
    // 設定は指定したSprint以外を外すので、2件の開いている所属は追加の操作で作る。
    for (const issueRef of ["AAA-1", fresh.id]) for (const sprint of [active, draft]) {
      expect((await call(app, "POST", `/api/sprints/${sprint.id}/issues`, { issueRef })).json.added).toBe(true);
    }
    const cleared = await set(app, "AAA-1", null);
    expect(cleared).toMatchObject({ status: 200, json: { added: false, removedSprintIds: [active.id, draft.id] } });
    expect(cleared.json.issue.sprints.map((s: any) => [s.number, s.association])).toEqual([[1, "imported"]]);
    expect(await refs(app, "AAA-1")).toEqual([[1, "imported", false]]);
    expect(ids(await call(app, "GET", `/api/issues?sprint=none`))).not.toContain("AAA-1");

    expect((await set(app, fresh.id, null)).json).toMatchObject({ added: false, removedSprintIds: [active.id, draft.id], issue: { sprints: [] } });
    expect(ids(await call(app, "GET", `/api/issues?sprint=none`))).toContain(fresh.id);
    for (const sprint of [active, draft]) expect(ids(await call(app, "GET", `/api/issues?sprint=${sprint.id}`))).not.toContain(fresh.id);
    expect(sprintEvents((await call(app, "GET", `/api/issues/${fresh.id}`)).json).filter((e: any) => e[0] === "sprint_removed"))
      .toEqual([["sprint_removed", "me", active.number], ["sprint_removed", "me", draft.number]]);
  } finally { db.close(); }
});

test("同じ設定の再送は何も書かず、所属・item・追加者と時刻・Activityの件数が変わらない", async () => {
  const { db, app, ws, me, create } = await configured();
  try {
    const draft = await create("2026-11-01");
    const issue = createIssue(me, { workspaceId: ws.id, title: "二重のクリック" });
    const first = await set(app, issue.id, draft.id);
    const item = (await call(app, "GET", `/api/sprints/${draft.id}`)).json.items;
    const detail = (await call(app, "GET", `/api/issues/${issue.id}`)).json;
    for (const ref of [draft.id, String(draft.number)]) {
      const again = await set(app, issue.id, ref);
      expect(again).toMatchObject({ status: 200, json: { added: false, removedSprintIds: [] } });
      expect(again.json.issue).toEqual(first.json.issue);
    }
    expect((await call(app, "GET", `/api/sprints/${draft.id}`)).json.items).toEqual(item);
    expect((await call(app, "GET", `/api/issues/${issue.id}`)).json).toEqual(detail);
    // 所属が無いときの「なし」の再送も同じ。
    expect((await set(app, issue.id, null)).json.removedSprintIds).toEqual([draft.id]);
    const cleared = (await call(app, "GET", `/api/issues/${issue.id}`)).json;
    expect(await set(app, issue.id, null)).toMatchObject({ status: 200, json: { added: false, removedSprintIds: [], issue: { sprints: [] } } });
    expect((await call(app, "GET", `/api/issues/${issue.id}`)).json).toEqual(cleared);
  } finally { db.close(); }
});

test("採択の所属が1件あるとき、そのSprintへの設定は他の追加を外し、なしや他のSprintへの設定は全体を拒否する", async () => {
  const { db, app, ws, me, create, agreed } = await configured();
  try {
    const adopted = createIssue(me, { workspaceId: ws.id, title: "採択済み" });
    const overlap = createIssue(me, { workspaceId: ws.id, title: "追加と採択の重なり" });
    const active = await agreed("2026-10-30", [adopted.id, overlap.id], "active");
    const ready = await agreed("2026-10-31", [createIssue(me, { workspaceId: ws.id, title: "次の計画" }).id], "ready");
    const draft = await create("2026-11-01");
    expect((await call(app, "POST", `/api/sprints/${active.id}/issues`, { issueRef: overlap.id })).json.added).toBe(true);
    for (const issue of [adopted, overlap]) for (const sprint of [ready, draft]) {
      expect((await call(app, "POST", `/api/sprints/${sprint.id}/issues`, { issueRef: issue.id })).json.added).toBe(true);
    }
    const states = async () => Promise.all([active, ready, draft].map(s => planState(app, s.id)));
    const before = await states();

    // 外す対象に採択の所属があれば、追加の所属も外さず、Activityも残さない。追加と採択が重なる所属も外せない。
    for (const issue of [adopted, overlap]) {
      const detail = (await call(app, "GET", `/api/issues/${issue.id}`)).json;
      const items = await Promise.all([active, ready, draft].map(async s => (await call(app, "GET", `/api/sprints/${s.id}`)).json.items));
      for (const ref of [null, ready.id, String(draft.number)]) {
        const rejected = await set(app, issue.id, ref);
        expect(rejected).toMatchObject({ status: 409, json: { error: { code: "INVALID_STATE", message: expect.stringContaining(active.name) } } });
      }
      expect((await call(app, "GET", `/api/issues/${issue.id}`)).json).toEqual(detail);
      expect(await Promise.all([active, ready, draft].map(async s => (await call(app, "GET", `/api/sprints/${s.id}`)).json.items))).toEqual(items);
    }

    // 採択のSprintを選ぶと、採択を保ったまま他の追加の所属だけが外れる。採択だけのitemには追加の記録が付く。
    const kept = await set(app, adopted.id, active.id);
    expect(kept).toMatchObject({ status: 200, json: { added: true, removedSprintIds: [ready.id, draft.id] } });
    expect(await refs(app, adopted.id)).toEqual([[active.number, "added", true]]);
    const overlapKept = await set(app, overlap.id, String(active.number));
    expect(overlapKept).toMatchObject({ status: 200, json: { added: false, removedSprintIds: [ready.id, draft.id] } });
    expect(await refs(app, overlap.id)).toEqual([[active.number, "added", true]]);
    expect(ids(await call(app, "GET", `/api/issues?sprint=current`)).sort()).toEqual([adopted.id, overlap.id].sort());
    expect(await states()).toEqual(before);
  } finally { db.close(); }
});

for (const closing of ["end", "cancel"] as const) {
  test(`外したIssueは分析のScopeと${closing === "end" ? "終了" : "中止"}の残件記録（未完了のIssueと未回答の質問）に入らない`, async () => {
    const { db, app, ws, me, llm, clock, agreed } = await configured();
    try {
      const planned = createIssue(me, { workspaceId: ws.id, title: "計画の仕事" });
      const active = await agreed("2026-10-30", [planned.id], "active");
      const kept = createIssue(me, { workspaceId: ws.id, title: "残す差し込み" });
      const removed = createIssue(me, { workspaceId: ws.id, title: "外す差し込み" });
      for (const issue of [kept, removed]) expect((await set(app, issue.id, active.id)).json.added).toBe(true);
      const keptQuestion = askQuestion(llm, kept.id, "残す範囲は").question;
      askQuestion(llm, removed.id, "外す範囲は");
      expect((await call(app, "GET", `/api/sprints/${active.id}/analytics`)).json).toMatchObject({ scope: 3 });
      expect((await set(app, removed.id, null)).json.removedSprintIds).toEqual([active.id]);
      expect((await call(app, "GET", `/api/sprints/${active.id}/analytics`)).json).toMatchObject({ statusBasis: "live_membership", scope: 2 });

      if (closing === "end") clock.now = new Date("2026-10-30T15:00:00.000Z");
      const current = (await call(app, "GET", `/api/sprints/${active.id}`)).json;
      expect((await call(app, "POST", `/api/sprints/${active.id}/${closing}`, { expectedVersion: current.version, requestKey: closing, reason: "区切り" })).status).toBe(200);
      expect((await call(app, "GET", `/api/sprints/${active.id}`)).json.closureRecord).toMatchObject({
        issues: [{ issueId: planned.id, status: "todo" }, { issueId: kept.id, status: "needs_clarification" }],
        questions: [{ questionId: keptQuestion.id, issueId: kept.id }] });
      // 閉じたSprintの所属は設定で変えない。
      const detail = (await call(app, "GET", `/api/issues/${kept.id}`)).json;
      expect(await set(app, kept.id, null)).toMatchObject({ status: 200, json: { added: false, removedSprintIds: [] } });
      expect((await call(app, "GET", `/api/issues/${kept.id}`)).json).toEqual(detail);
    } finally { db.close(); }
  });
}

test("外した後に同じSprintへ設定し直すと同じitemが所属に戻り、解除の前に提案された計画案に合意すると採択で戻る", async () => {
  const { db, app, ws, me, create } = await configured();
  try {
    const draft = await create("2026-11-01");
    const issue = createIssue(me, { workspaceId: ws.id, title: "戻す" });
    const proposedFor = createIssue(me, { workspaceId: ws.id, title: "案に含まれる" });
    await set(app, issue.id, draft.id); await set(app, proposedFor.id, draft.id);
    const itemOf = async (ref: string) => (await call(app, "GET", `/api/sprints/${draft.id}`)).json.items.find((i: any) => i.sourceIssueKey === ref);
    const original = await itemOf(issue.id);
    const proposed = (await call(app, "POST", `/api/sprints/${draft.id}/plans`, plan(draft.version, "解除前の案", [(await itemOf(proposedFor.id)).id]))).json;

    for (const ref of [issue.id, proposedFor.id]) expect((await set(app, ref, null)).json.removedSprintIds).toEqual([draft.id]);
    expect(await itemOf(issue.id)).toMatchObject({ id: original.id, member: false, addedBy: null });
    const back = await set(app, issue.id, draft.id);
    expect(back.json).toMatchObject({ added: true, removedSprintIds: [] });
    expect(await itemOf(issue.id)).toMatchObject({ id: original.id, member: true, association: "added", addedBy: "me", snapshot: original.snapshot });
    expect(sprintEvents((await call(app, "GET", `/api/issues/${issue.id}`)).json)).toEqual([
      ["sprint_added", "me", draft.number], ["sprint_removed", "me", draft.number], ["sprint_added", "me", draft.number]]);

    // 解除は将来の採択を禁じない。
    expect(await refs(app, proposedFor.id)).toEqual([]);
    const accepted = await call(app, "POST", `/api/sprints/${draft.id}/plans/${proposed.plan.id}/accept`, { expectedVersion: proposed.sprint.version, requestKey: "合意", contentHash: proposed.plan.contentHash });
    expect(accepted.status).toBe(200);
    expect(await refs(app, proposedFor.id)).toEqual([[draft.number, "adopted", true]]);
  } finally { db.close(); }
});

test("設定できないSprint・Issue・入力を理由つきで拒否し、何も書かない", async () => {
  const { db, app, ws, me, clock, create, agreed } = await configured(true);
  try {
    clock.now = new Date("2026-10-29T03:00:00.000Z");
    const ended = await agreed("2026-10-29", [createIssue(me, { workspaceId: ws.id, title: "前の計画" }).id], "active");
    clock.now = new Date("2026-10-29T15:00:00.000Z");
    await call(app, "POST", `/api/sprints/${ended.id}/end`, { expectedVersion: ended.version, requestKey: "終了", reason: "期間の終了" });
    clock.now = new Date("2026-10-30T03:00:00.000Z");
    const canceled = await create("2026-11-02");
    expect((await call(app, "POST", `/api/sprints/${canceled.id}/cancel`, { expectedVersion: canceled.version, requestKey: "中止", reason: "取りやめ" })).json.phase).toBe("canceled");
    const draft = await create("2026-11-01");
    const issue = createIssue(me, { workspaceId: ws.id, title: "設定する" });
    expect((await set(app, issue.id, draft.id)).json.added).toBe(true);
    const snapshot = async () => [(await call(app, "GET", `/api/issues/${issue.id}`)).json, (await call(app, "GET", `/api/sprints/${draft.id}`)).json];
    const before = await snapshot();

    const path = `/api/issues/${issue.id}/sprint`;
    for (const body of [{}, { sprintRef: "" }, { sprintRef: "  " }, { sprintRef: 1 }, { sprintRef: true }, { sprintRef: [draft.id] }, { sprintRef: "current" }, { sprintRef: "none" },
      { sprintRef: null, actor: "codex" }, { sprintRef: draft.id, expectedVersion: draft.version }, { sprintRef: draft.id, issueRef: issue.id }]) {
      expect(await call(app, "POST", path, body)).toMatchObject({ status: 400, json: { error: { code: "INVALID_ARGS" } } });
    }
    for (const ref of ["999", crypto.randomUUID()]) expect(await set(app, issue.id, ref)).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    expect(await set(app, "AAA-999", draft.id)).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    // 移行履歴・終了・中止のSprintは指定できない。
    for (const ref of ["1", ended.id, canceled.id]) expect(await set(app, issue.id, ref)).toMatchObject({ status: 409, json: { error: { code: "INVALID_STATE" } } });
    // 別のWorkspaceのIssue。
    expect(await set(app, "BBB-1", draft.id)).toMatchObject({ status: 400, json: { error: { code: "INVALID_ARGS" } } });
    expect(await snapshot()).toEqual(before);

    // アーカイブ済みのIssueは、なしへの設定も拒否する。
    expect((await call(app, "POST", `/api/issues/${issue.id}/archive`, {})).status).toBe(200);
    const archived = await snapshot();
    for (const ref of [draft.id, null]) expect(await set(app, issue.id, ref)).toMatchObject({ status: 409, json: { error: { code: "ISSUE_ARCHIVED" } } });
    expect(await snapshot()).toEqual(archived);
  } finally { db.close(); }
});

test("削除後に再利用されたIssue IDとWorkspaceを削除したSprintへの設定を拒否する", async () => {
  const { db, app, ws, me, create } = await configured();
  try {
    const draft = await create("2026-11-01");
    const removed = createIssue(me, { workspaceId: ws.id, title: "削除する" });
    expect((await set(app, removed.id, draft.id)).json.added).toBe(true);
    archiveIssue(me, removed.id); deleteIssue(me, removed.id);
    db.query("UPDATE workspaces SET next_number=? WHERE id=?").run(removed.number, ws.id);
    const reused = createIssue(me, { workspaceId: ws.id, title: "番号の再利用" });
    expect(reused.id).toBe(removed.id);
    expect(await set(app, reused.id, draft.id)).toMatchObject({ status: 409, json: { error: { code: "TARGET_CHANGED" } } });
    expect((await call(app, "GET", `/api/issues/${reused.id}`)).json.sprints).toEqual([]);

    const other = initWorkspace(db, { path: "/tmp/repos/other-ws" }).workspace;
    const foreign = createIssue(me, { workspaceId: other.id, title: "別Workspace" });
    removeWorkspace(db, ws.key);
    expect(await set(app, foreign.id, draft.id)).toMatchObject({ status: 409, json: { error: { code: "INVALID_STATE" } } });
    expect((await call(app, "GET", `/api/issues/${foreign.id}`)).json.sprints).toEqual([]);
  } finally { db.close(); }
});

test("期限を過ぎたactiveとScrum運用が無効のWorkspaceのSprintは、それだけでは拒否しない", async () => {
  const { db, app, ws, me, clock, create, agreed } = await configured();
  try {
    const active = await agreed("2026-10-30", [createIssue(me, { workspaceId: ws.id, title: "今の計画" }).id], "active");
    const draft = await create("2026-11-01");
    clock.now = new Date("2026-10-31T00:00:00.000Z");
    expect((await call(app, "GET", `/api/sprints/${active.id}`)).json.phase).toBe("active");
    const issue = createIssue(me, { workspaceId: ws.id, title: "期限超過へ入れる" });
    expect(await set(app, issue.id, active.id)).toMatchObject({ status: 200, json: { added: true } });
    const scrum = (await call(app, "GET", `/api/workspaces/${ws.key}/scrum`)).json;
    expect((await call(app, "PUT", `/api/workspaces/${ws.key}/scrum`, { expectedVersion: scrum.version, requestKey: "無効化", enabled: false, problem: "p", productGoal: "g", priorityRationale: "r" })).json.enabled).toBe(false);
    expect(await set(app, issue.id, draft.id)).toMatchObject({ status: 200, json: { added: true, removedSprintIds: [active.id] } });
    expect(await set(app, issue.id, null)).toMatchObject({ status: 200, json: { removedSprintIds: [draft.id], issue: { sprints: [] } } });
  } finally { db.close(); }
});
