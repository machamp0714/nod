import { expect, test } from "bun:test";
import * as core from "../src/index";
import { codeOf, setup } from "./helpers";

function configured() {
  const f = setup();
  core.configureScrumWorkspace(f.me, f.ws.key, { expectedVersion: 0, requestKey: "設定", enabled: true, problem: "停滞", productGoal: "開発を進める", priorityRationale: "判断を優先" });
  return f;
}
const period = { startDate: "2026-03-08", endDate: "2026-03-08", timezone: "America/New_York" };
function draft() {
  const f = configured();
  const sprint = core.createSprint(f.llm, { ...period, workspaceKey: f.ws.key, expectedVersion: 0, requestKey: "作成" });
  return { ...f, sprint };
}
const planInput = (itemId: string, version: number) => ({ expectedVersion: version, requestKey: "計画", goal: "判断後に再開できる", verificationMethod: "回答から再開までを一巡する",
  items: [{ itemId, contribution: "判断を一か所に集める", executionPlan: "既存Inboxから接続する" }],
  definitionOfDone: [{ id: "操作", text: "回答から再開まで確認できる" }], constraints: { executionScope: "対象Workspace", maxParallel: 2, notes: "公開は既存権限に従う" }, changeReason: "最初の提案" });
function proposal() {
  const f = draft();
  const issue = core.createIssue(f.me, { workspaceId: f.ws.id, title: "判断を表示" });
  const added = core.addSprintCandidate(f.llm, f.sprint.id, { expectedVersion: f.sprint.version, requestKey: "候補", issueRef: issue.id });
  const proposed = core.proposeSprintPlan(f.llm, f.sprint.id, planInput(added.item.id, added.sprint.version));
  return { ...f, issue, item: added.item, ...proposed };
}

test("中止期間への未関連の期間更新を拒否しSprintを変更しない", () => {
  const { db, ws, me, llm, sprint, plan } = proposal();
  try {
    const clock = { now: new Date("2026-03-08T12:00:00.000Z") };
    const ready = core.acceptSprintPlan(me, sprint.id, plan.id, { expectedVersion: sprint.version, requestKey: "合意", contentHash: plan.contentHash });
    const active = core.activateSprint(me, sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, clock);
    core.cancelSprint(me, sprint.id, { expectedVersion: active.version, requestKey: "中止", reason: "優先順位を再検討する" }, clock);
    const unlinked = core.createSprint(llm, { ...period, startDate: "2026-03-10", endDate: "2026-03-10", workspaceKey: ws.key, expectedVersion: 0, requestKey: "未関連作成" });
    const before = core.getSprint(db, unlinked.id);

    expect(codeOf(() => core.updateSprint(llm, unlinked.id, { ...period, expectedVersion: unlinked.version, requestKey: "中止期間へ変更" }))).toBe("INVALID_ARGS");
    expect(core.getSprint(db, unlinked.id)).toEqual(before);
  } finally {
    db.close();
  }
});

function canceledProposal() {
  const f = proposal();
  const clock = { now: new Date("2026-03-08T12:00:00.000Z") };
  const ready = core.acceptSprintPlan(f.me, f.sprint.id, f.plan.id, { expectedVersion: f.sprint.version, requestKey: "合意", contentHash: f.plan.contentHash });
  const active = core.activateSprint(f.me, f.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, clock);
  const sprint = core.cancelSprint(f.me, f.sprint.id, { expectedVersion: active.version, requestKey: "中止", reason: "再計画する" }, clock);
  return { ...f, sprint };
}

test("既存の中止元関連を保持して期間を更新し、版・再送・actorの整合を守る", () => {
  const { db, ws, me, llm, sprint } = canceledProposal();
  try {
    const linked = core.createSprint(llm, { ...period, startDate: "2026-03-10", endDate: "2026-03-10", workspaceKey: ws.key, expectedVersion: 0, requestKey: "関連済み作成", replansSprintId: sprint.id });
    const input = { ...period, expectedVersion: linked.version, requestKey: "関連を保持して変更" };
    const updated = core.updateSprint(llm, linked.id, input);
    expect(updated).toMatchObject({ ...period, startsAt: sprint.startsAt, endsAt: sprint.endsAt, replansSprintId: sprint.id, version: linked.version + 1 });
    expect(core.getSprint(db, linked.id)).toMatchObject(updated);
    expect(core.updateSprint(llm, linked.id, input)).toEqual(updated);
    expect(codeOf(() => core.updateSprint(llm, linked.id, { ...input, requestKey: "古い版" }))).toBe("STALE_REVISION");
    expect(codeOf(() => core.updateSprint(llm, linked.id, { ...input, name: "異なる入力" }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(codeOf(() => core.updateSprint(me, linked.id, input))).toBe("IDEMPOTENCY_CONFLICT");
    expect(codeOf(() => core.updateSprint(llm, linked.id, { expectedVersion: updated.version, requestKey: "関連付替え", replansSprintId: null } as any))).toBe("INVALID_ARGS");
    expect(core.getSprint(db, linked.id)).toMatchObject(updated);
  } finally {
    db.close();
  }
});

test("別の中止元への関連だけでは期間更新を許さず、activeの期間固定も維持する", () => {
  const { db, ws, me, llm, sprint } = canceledProposal();
  try {
    const other = core.createSprint(llm, { ...period, startDate: "2026-03-06", endDate: "2026-03-06", workspaceKey: ws.key, expectedVersion: 0, requestKey: "別中止元作成" });
    core.cancelSprint(me, other.id, { expectedVersion: other.version, requestKey: "別中止元を中止", reason: "別の再計画" });
    const linked = core.createSprint(llm, { ...period, startDate: "2026-03-10", endDate: "2026-03-10", workspaceKey: ws.key, expectedVersion: 0, requestKey: "誤った関連作成", replansSprintId: other.id });
    const before = core.getSprint(db, linked.id);
    expect(codeOf(() => core.updateSprint(llm, linked.id, { ...period, expectedVersion: linked.version, requestKey: "別中止期間へ変更" }))).toBe("INVALID_ARGS");
    expect(core.getSprint(db, linked.id)).toEqual(before);
    const proposed = core.proposeSprintPlan(llm, linked.id, { ...planInput("", linked.version), items: [] });
    const ready = core.acceptSprintPlan(me, linked.id, proposed.plan.id, { expectedVersion: proposed.sprint.version, requestKey: "次合意", contentHash: proposed.plan.contentHash });
    const active = core.activateSprint(me, linked.id, { expectedVersion: ready.sprint.version, requestKey: "次開始" }, { now: new Date("2026-03-10T12:00:00.000Z") });
    expect(codeOf(() => core.updateSprint(me, linked.id, { ...period, expectedVersion: active.version, requestKey: "開始後の期間変更" }))).toBe("INVALID_STATE");
    expect(core.getSprint(db, linked.id)).toMatchObject({ ...active, replansSprintId: other.id });
    expect(core.getSprint(db, sprint.id).phase).toBe("canceled");
  } finally {
    db.close();
  }
});

test("中止期間に前後で隣接する更新と通常の非重複更新を許し、通常期間の重複は拒否する", () => {
  const { db, ws, me, llm, sprint } = canceledProposal();
  try {
    let next = core.createSprint(llm, { ...period, startDate: "2026-03-10", endDate: "2026-03-10", workspaceKey: ws.key, expectedVersion: 0, requestKey: "通常作成" });
    next = core.updateSprint(llm, next.id, { expectedVersion: next.version, requestKey: "後隣接", startDate: "2026-03-09", endDate: "2026-03-09" });
    expect(next).toMatchObject({ startsAt: sprint.endsAt, replansSprintId: null });
    next = core.updateSprint(me, next.id, { expectedVersion: next.version, requestKey: "前隣接", startDate: "2026-03-07", endDate: "2026-03-07" });
    expect(next).toMatchObject({ endsAt: sprint.startsAt, replansSprintId: null });
    next = core.updateSprint(llm, next.id, { expectedVersion: next.version, requestKey: "通常変更", startDate: "2026-03-12", endDate: "2026-03-12" });
    expect(next).toMatchObject({ startDate: "2026-03-12", endDate: "2026-03-12", version: 4, replansSprintId: null });
    const occupied = core.createSprint(llm, { ...period, startDate: "2026-03-13", endDate: "2026-03-13", workspaceKey: ws.key, expectedVersion: 0, requestKey: "通常の別期間" });
    expect(codeOf(() => core.updateSprint(llm, next.id, { expectedVersion: next.version, requestKey: "通常重複", startDate: occupied.startDate, endDate: occupied.endDate }))).toBe("SPRINT_OVERLAP");
    expect(core.getSprint(db, next.id)).toMatchObject(next);
  } finally {
    db.close();
  }
});

test("人がWorkspaceの問題・目標・優先順位を版付きで設定し、同じ要求を再送できる", () => {
  const { db, ws, me, llm } = setup();
  expect(core.getScrumWorkspace(db, ws.key)).toMatchObject({ enabled: false, version: 0 });
  const input = { expectedVersion: 0, requestKey: "方向1", enabled: true, problem: "判断待ちで停滞する", productGoal: "迷わず開発を進める", priorityRationale: "回答から再開までを優先" };
  expect(codeOf(() => core.configureScrumWorkspace(llm, ws.key, input))).toBe("FORBIDDEN_FOR_LLM");
  const configured = core.configureScrumWorkspace(me, ws.key, input);
  expect(configured).toMatchObject({ enabled: true, problem: input.problem, productGoal: input.productGoal, priorityRationale: input.priorityRationale, version: 1, workspaceId: ws.id });
  expect(core.getScrumWorkspace(db, ws.key)).toEqual(configured);
  expect(core.configureScrumWorkspace(me, ws.key, input)).toEqual(configured);
  expect(codeOf(() => core.configureScrumWorkspace(me, ws.key, { ...input, problem: "別の問題" }))).toBe("IDEMPOTENCY_CONFLICT");
  expect(codeOf(() => core.configureScrumWorkspace(me, ws.key, { ...input, requestKey: "方向2" }))).toBe("STALE_REVISION");
  db.close();
});

test("人の合意を版とhashに固定し、同内容の合意を再利用して期間内だけ開始・中止できる", () => {
  const { db, ws, me, llm, sprint, plan, item } = proposal();
  const agreement = { expectedVersion: sprint.version, requestKey: "合意", contentHash: plan.contentHash, agreementSource: { source: "chat:合意", quote: "このゴールと範囲で進める" } };
  expect(codeOf(() => core.acceptSprintPlan(llm, sprint.id, plan.id, agreement))).toBe("FORBIDDEN_FOR_LLM");
  expect(codeOf(() => core.acceptSprintPlan(me, sprint.id, plan.id, { ...agreement, contentHash: "別hash" }))).toBe("STALE_REVISION");
  const ready = core.acceptSprintPlan(me, sprint.id, plan.id, agreement);
  expect(ready).toMatchObject({ sprint: { phase: "ready", adoptedPlanId: plan.id }, plan: { agreedBy: "me", agreedHash: plan.contentHash, agreementSource: agreement.agreementSource } });
  expect(core.acceptSprintPlan(me, sprint.id, plan.id, agreement)).toEqual(ready);
  const changed = core.proposeSprintPlan(llm, sprint.id, { ...planInput(item.id, ready.sprint.version), requestKey: "未合意変更", goal: "違うゴール" });
  expect(changed).toMatchObject({ sprint: { phase: "draft", adoptedPlanId: plan.id }, plan: { agreedBy: null } });
  const clock = { now: new Date("2026-03-08T12:00:00.000Z") };
  expect(codeOf(() => core.activateSprint(me, sprint.id, { expectedVersion: changed.sprint.version, requestKey: "未合意開始" }, clock))).toBe("NOT_ACCEPTED");
  const same = core.proposeSprintPlan(llm, sprint.id, { ...planInput(item.id, changed.sprint.version), requestKey: "同内容再提案" });
  expect(same).toMatchObject({ sprint: { phase: "ready", adoptedPlanId: same.plan.id }, plan: { agreedAt: ready.plan.agreedAt, agreedHash: plan.contentHash, agreementSource: agreement.agreementSource } });
  const activation = { expectedVersion: same.sprint.version, requestKey: "開始" };
  expect(codeOf(() => core.activateSprint(llm, sprint.id, activation, clock))).toBe("FORBIDDEN_FOR_LLM");
  expect(codeOf(() => core.activateSprint(me, sprint.id, activation, { now: new Date("2026-03-08T04:59:59.999Z") }))).toBe("SPRINT_NOT_ACTIVE");
  expect(codeOf(() => core.activateSprint(me, sprint.id, activation, { now: new Date("2026-03-09T04:00:00.000Z") }))).toBe("SPRINT_EXPIRED");
  const active = core.activateSprint(me, sprint.id, activation, clock);
  expect(active).toMatchObject({ phase: "active", activatedAt: clock.now.toISOString() });
  expect(core.activateSprint(me, sprint.id, activation, clock)).toEqual(active);
  expect(codeOf(() => core.updateSprint(me, sprint.id, { expectedVersion: active.version, requestKey: "延長", endDate: "2026-03-09" }))).toBe("INVALID_STATE");
  expect(core.resolveCurrentSprints(db, { clock }).sprints.map(s => s.id)).toEqual([sprint.id]);
  expect(codeOf(() => core.cancelSprint(llm, sprint.id, { expectedVersion: active.version, requestKey: "中止", reason: "優先順位変更" }))).toBe("FORBIDDEN_FOR_LLM");
  const canceled = core.cancelSprint(me, sprint.id, { expectedVersion: active.version, requestKey: "中止", reason: "優先順位変更" }, clock);
  expect(canceled).toMatchObject({ phase: "canceled", cancelReason: "優先順位変更" });
  expect(core.resolveCurrentSprints(db, { clock }).issues).toEqual([]);
  expect(codeOf(() => core.createSprint(me, { ...period, workspaceKey: ws.key, expectedVersion: 0, requestKey: "再計画根拠なし" }))).toBe("INVALID_ARGS");
  expect(core.createSprint(me, { ...period, workspaceKey: ws.key, expectedVersion: 0, requestKey: "再計画", replansSprintId: sprint.id }).replansSprintId).toBe(sprint.id);
  db.close();
});

test("候補の安定itemと要求の写しを使い、理由・DoD・制約を持つ計画を追記する", () => {
  const { db, ws, me, llm, sprint } = draft();
  const issue = core.createIssue(me, { workspaceId: ws.id, title: "判断を表示", description: "未回答を識別する" });
  const added = core.addSprintCandidate(llm, sprint.id, { expectedVersion: sprint.version, requestKey: "候補", issueRef: issue.id });
  expect(added.item).toMatchObject({ sourceIssueKey: issue.id, origin: "candidate", snapshot: { issue: { title: "判断を表示", description: "未回答を識別する" } } });
  const duplicate = core.addSprintCandidate(llm, sprint.id, { expectedVersion: added.sprint.version, requestKey: "同じ候補", issueRef: issue.id });
  expect(duplicate.item.id).toBe(added.item.id);
  const proposed = core.proposeSprintPlan(llm, sprint.id, planInput(added.item.id, duplicate.sprint.version));
  expect(proposed.plan).toMatchObject({ revision: 1, agreedBy: null, content: { schemaVersion: 1, goal: "判断後に再開できる", period: { startsAt: "2026-03-08T05:00:00.000Z" }, items: [{ itemId: added.item.id, requirement: { title: "判断を表示", description: "未回答を識別する" } }] } });
  expect(proposed.plan.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(proposed.sprint.adoptedPlanId).toBeNull();
  expect(core.getSprint(db, sprint.id).plans).toEqual([proposed.plan]);
  const second = core.proposeSprintPlan(llm, sprint.id, { ...planInput(added.item.id, proposed.sprint.version), requestKey: "変更案", goal: "別のゴール", changeReason: "価値を変える" });
  expect(second.plan.revision).toBe(2);
  expect(second.plan.contentHash).not.toBe(proposed.plan.contentHash);
  expect(core.getSprint(db, sprint.id).plans[0]).toEqual(proposed.plan);
  expect(codeOf(() => core.proposeSprintPlan(llm, sprint.id, { ...planInput(added.item.id, second.sprint.version), requestKey: "重複item", items: [planInput(added.item.id, 0).items[0]!, planInput(added.item.id, 0).items[0]!] }))).toBe("INVALID_ARGS");
  db.close();
});

test("Sprint自身のtimezoneで夏時間の日を23時間とし、共通番号と期間重複・入力の整合を守る", () => {
  const { db, ws, llm } = configured();
  const input = { ...period, workspaceKey: ws.key, expectedVersion: 0, requestKey: "作成" };
  const sprint = core.createSprint(llm, input);
  expect(sprint).toMatchObject({ number: 1, name: "Sprint 1", phase: "draft", version: 1, startsAt: "2026-03-08T05:00:00.000Z", endsAt: "2026-03-09T04:00:00.000Z", workingDays: [1, 2, 3, 4, 5] });
  expect(core.createSprint(llm, input)).toEqual(sprint);
  expect(codeOf(() => core.createSprint(llm, { ...input, requestKey: "重複" }))).toBe("SPRINT_OVERLAP");
  expect(codeOf(() => core.createSprint(llm, { ...input, requestKey: "不正日", startDate: "2026-02-30" }))).toBe("INVALID_ARGS");
  expect(codeOf(() => core.createSprint(llm, { ...input, requestKey: "不正zone", timezone: "invalid" }))).toBe("INVALID_ARGS");
  const next = core.createSprint(llm, { ...input, requestKey: "次", startDate: "2026-03-09", endDate: "2026-03-09" });
  expect(next.number).toBe(2);
  const updated = core.updateSprint(llm, next.id, { expectedVersion: next.version, requestKey: "秋", startDate: "2026-11-01", endDate: "2026-11-01" });
  expect(updated).toMatchObject({ version: 2, startsAt: "2026-11-01T04:00:00.000Z", endsAt: "2026-11-02T05:00:00.000Z" });
  db.close();
});

test("要求が変わった計画へ旧合意を適用せず、候補・採択の写しはIssue削除後も残る", () => {
  const { db, me, llm, sprint, plan, issue, item } = proposal();
  core.updateIssue(me,issue.id,{description:"後から変えた要求"});
  const agreement = {expectedVersion:sprint.version,requestKey:"合意",contentHash:plan.contentHash};
  expect(codeOf(() => core.acceptSprintPlan(me,sprint.id,plan.id,agreement))).toBe("TARGET_CHANGED");
  const revised = core.proposeSprintPlan(llm,sprint.id,{...planInput(item.id,sprint.version),requestKey:"新しい要求"});
  expect(revised.plan.content.items[0]!.requirement.description).toBe("後から変えた要求");
  const accepted = core.acceptSprintPlan(me,sprint.id,revised.plan.id,{...agreement,expectedVersion:revised.sprint.version,contentHash:revised.plan.contentHash});
  core.archiveIssue(me,issue.id); core.deleteIssue(me,issue.id);
  const history = core.getSprint(db,sprint.id);
  expect(history.items[0]).toMatchObject({issueId:null,snapshot:{issue:{title:"判断を表示",description:null}}});
  expect(history.plans).toEqual([plan,accepted.plan]);
  expect(codeOf(() => core.activateSprint(me,sprint.id,{expectedVersion:accepted.sprint.version,requestKey:"削除後の開始"},{now:new Date("2026-03-08T12:00:00Z")}))).toBe("TARGET_CHANGED");
  db.close();
});

test("同じWorkspaceで既存activeを残したまま次のSprintを開始できず、別Workspaceでは開始できる", () => {
  const f = proposal();
  const ready = core.acceptSprintPlan(f.me,f.sprint.id,f.plan.id,{expectedVersion:f.sprint.version,requestKey:"合意",contentHash:f.plan.contentHash});
  core.activateSprint(f.me,f.sprint.id,{expectedVersion:ready.sprint.version,requestKey:"開始"},{now:new Date("2026-03-08T12:00:00Z")});
  const createReady = (workspaceKey:string) => {
    const sprint = core.createSprint(f.llm,{workspaceKey,startDate:"2026-03-09",endDate:"2026-03-09",timezone:"America/New_York",expectedVersion:0,requestKey:"次"});
    const plan = core.proposeSprintPlan(f.llm,sprint.id,{...planInput("",sprint.version),items:[]});
    return core.acceptSprintPlan(f.me,sprint.id,plan.plan.id,{expectedVersion:plan.sprint.version,requestKey:"次合意",contentHash:plan.plan.contentHash});
  };
  const next = createReady(f.ws.key);
  const clock = {now:new Date("2026-03-09T12:00:00Z")};
  expect(codeOf(() => core.activateSprint(f.me,next.sprint.id,{expectedVersion:next.sprint.version,requestKey:"次開始"},clock))).toBe("SPRINT_ALREADY_ACTIVE");
  const other = core.initWorkspace(f.db,{key:"BBB",name:"別Workspace",path:"/tmp/repos/bbb"}).workspace;
  core.configureScrumWorkspace(f.me,other.key,{enabled:true,problem:"別の問題",productGoal:"別の目標",priorityRationale:"別の優先順位",expectedVersion:0,requestKey:"設定"});
  const independent = createReady(other.key);
  expect(core.activateSprint(f.me,independent.sprint.id,{expectedVersion:independent.sprint.version,requestKey:"独立開始"},clock).phase).toBe("active");
  f.db.close();
});

test("Workspace削除後もSprintの写しと計画を保持し、再利用されたWorkspace IDへつなぎ直さない", () => {
  const { db, me, ws, sprint, plan } = proposal();
  core.removeWorkspace(db,ws.key);
  const historical = core.getSprint(db,sprint.id);
  expect(historical).toMatchObject({workspaceId:null,workspaceSnapshot:{id:ws.id,key:ws.key,name:ws.name},plans:[plan]});
  const next = core.initWorkspace(db,{path:"/tmp/別プロダクト",key:"NEW",name:"別プロダクト"}).workspace;
  expect(core.getScrumWorkspace(db,next.key)).toMatchObject({enabled:false,version:0});
  expect(core.configureScrumWorkspace(me,next.key,{enabled:true,problem:"別",productGoal:"別",priorityRationale:"別",expectedVersion:0,requestKey:"設定"}).problem).toBe("別");
  expect(core.getSprint(db,sprint.id).workspaceId).toBeNull();
  expect(codeOf(() => core.updateSprint(me,sprint.id,{expectedVersion:sprint.version,requestKey:"削除後更新",name:"変更"}))).toBe("INVALID_STATE");
  db.close();
});

test("JSONの型・未知の制約・欠落した版とrequestKeyをcoreで拒否する", () => {
  const { db, me, sprint, item } = proposal();
  for (const value of [null,[],{expectedVersion:-1,requestKey:"負数"},{expectedVersion:sprint.version},{expectedVersion:sprint.version,requestKey:"空",timezone:null}]) {
    expect(codeOf(() => core.updateSprint(me,sprint.id,value as any))).toBe("INVALID_ARGS");
  }
  expect(codeOf(() => core.proposeSprintPlan(me,sprint.id,{...planInput(item.id,sprint.version),constraints:{executionScope:"WS",maxParallel:1,notes:"制約",budget:100} as any}))).toBe("INVALID_ARGS");
  db.close();
});
