import type { Database } from "bun:sqlite";
import { HUMAN_ACTOR, isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { invalidSprint, sprintHash, sprintObject, sprintPeriod, sprintText, sprintVersion } from "../sprint-validation";
import type { Sprint, SprintClock, SprintItem, SprintPlan, SprintPlanContent, SprintPlanConstraints } from "../sprint-types";
import { nextSprintNumber, resolveSprint } from "./sprints";
import { findIssueRow } from "../issue-query";
import { findWorkspace } from "./workspaces";
import { saveSprintClosure } from "./sprint-closure";

export interface SprintMutation { expectedVersion: number; requestKey: string }
export interface ScrumWorkspace {
  workspaceId: number; enabled: boolean; problem: string | null; productGoal: string | null;
  priorityRationale: string | null; version: number; updatedAt: string | null;
}

export interface CreateSprintInput extends SprintMutation {
  workspaceKey: string; name?: string; startDate: string; endDate: string; timezone: string;
  workingDays?: number[]; replansSprintId?: string;
}
export interface UpdateSprintInput extends SprintMutation {
  name?: string; startDate?: string; endDate?: string; timezone?: string; workingDays?: number[];
}
function writableSprint(db: Database, ref: string): Sprint {
  const sprint = resolveSprint(db, ref);
  if (["imported", "ended", "canceled"].includes(sprint.phase)) throw new NodError("INVALID_STATE", "履歴・終了・中止済みのSprintは変更できません");
  if (sprint.workspaceId === null) throw new NodError("INVALID_STATE", "Workspaceが削除されています");
  return sprint;
}
function workingDays(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.some(v => !Number.isInteger(v) || v < 0 || v > 6) || new Set(value).size !== value.length) return invalidSprint("稼働曜日は0〜6の重複しない整数配列で指定してください");
  return [...value].sort((a, b) => a - b);
}
function nonOverlapping(db: Database, ws: number, period: { startsAt: string; endsAt: string }, exclude?: string): void {
  if (db.query(`SELECT id FROM sprints WHERE workspace_id=? AND phase NOT IN ('imported','canceled')
    AND id<>? AND julianday(starts_at)<julianday(?) AND julianday(ends_at)>julianday(?)`).get(ws, exclude ?? "", period.endsAt, period.startsAt)) {
    throw new NodError("SPRINT_OVERLAP", "同じWorkspaceのSprint期間が重複しています");
  }
}
function checkReplanning(db: Database, ws: number, period: { startsAt: string; endsAt: string }, replansSprintId?: string | null): void {
  const canceled = db.query(`SELECT id FROM sprints WHERE workspace_id=? AND phase='canceled'
    AND julianday(starts_at)<julianday(?) AND julianday(ends_at)>julianday(?)`).all(ws, period.endsAt, period.startsAt) as {id:string}[];
  if (canceled.length && !canceled.some(s => s.id === replansSprintId)) invalidSprint("中止した期間の再計画ではreplansSprintIdを指定してください");
  if (replansSprintId) {
    const original = resolveSprint(db, replansSprintId);
    if (original.phase !== "canceled" || original.workspaceId !== ws) invalidSprint("再計画元は同じWorkspaceの中止済みSprintを指定してください");
  }
}
export function createSprint(ctx: OpCtx, input: CreateSprintInput): Sprint {
  sprintObject(input, [...MUTATION_KEYS, "workspaceKey", "name", "startDate", "endDate", "timezone", "workingDays", "replansSprintId"]);
  const ws = workspace(ctx.db, sprintText(input.workspaceKey, "Workspace"));
  const period = sprintPeriod(input.startDate, input.endDate, input.timezone);
  const days = workingDays(input.workingDays === undefined ? [1, 2, 3, 4, 5] : input.workingDays);
  if (input.replansSprintId !== undefined) sprintText(input.replansSprintId,"再計画元Sprint");
  return mutate(ctx, `workspace:${ws.id}`, "create", input, () => {
    checkVersion(0, input.expectedVersion);
    if (!getScrumWorkspace(ctx.db, ws.key).enabled) throw new NodError("SCRUM_DISABLED", "WorkspaceのSprint運用が有効ではありません");
    nonOverlapping(ctx.db, ws.id, period);
    checkReplanning(ctx.db, ws.id, period, input.replansSprintId);
    const id = crypto.randomUUID(), number = nextSprintNumber(ctx.db), timestamp = now();
    ctx.db.query(`INSERT INTO sprints(id,number,workspace_id,name,phase,start_date,end_date,timezone,starts_at,ends_at,created_at,updated_at,version,working_days,workspace_snapshot,replans_sprint_id)
      VALUES(?,?,?,?,'draft',?,?,?,?,?,?,?,1,?,?,?)`).run(id, number, ws.id, input.name === undefined ? `Sprint ${number}` : sprintText(input.name, "名前"),
      period.startDate, period.endDate, period.timezone, period.startsAt, period.endsAt, timestamp, timestamp, JSON.stringify(days), JSON.stringify({ id: ws.id, key: ws.key, name: ws.name }), input.replansSprintId ?? null);
    return resolveSprint(ctx.db, id);
  });
}
export function updateSprint(ctx: OpCtx, ref: string, input: UpdateSprintInput): Sprint {
  sprintObject(input, [...MUTATION_KEYS, "name", "startDate", "endDate", "timezone", "workingDays"]);
  for (const key of ["name","startDate","endDate","timezone"] as const) if (input[key] !== undefined) sprintText(input[key],key);
  const id = resolveSprint(ctx.db, ref).id;
  return mutate(ctx, id, "update", input, () => {
    const sprint = writableSprint(ctx.db, id);
    checkVersion(sprint.version, input.expectedVersion);
    const period = sprintPeriod(input.startDate ?? sprint.startDate, input.endDate ?? sprint.endDate, input.timezone ?? sprint.timezone);
    const days = workingDays(input.workingDays === undefined ? sprint.workingDays : input.workingDays);
    const periodChanged = period.startsAt !== sprint.startsAt || period.endsAt !== sprint.endsAt || period.timezone !== sprint.timezone || JSON.stringify(days) !== JSON.stringify(sprint.workingDays);
    if (sprint.phase === "active" && periodChanged) throw new NodError("INVALID_STATE", "開始済みSprintの期間・timezone・稼働曜日は変更できません");
    nonOverlapping(ctx.db, sprint.workspaceId!, period, sprint.id);
    checkReplanning(ctx.db, sprint.workspaceId!, period, sprint.replansSprintId);
    ctx.db.query(`UPDATE sprints SET name=?,start_date=?,end_date=?,timezone=?,starts_at=?,ends_at=?,working_days=?,
      phase=?,version=version+1,updated_at=? WHERE id=?`).run(input.name === undefined ? sprint.name : sprintText(input.name, "名前"), period.startDate, period.endDate, period.timezone, period.startsAt, period.endsAt,
      JSON.stringify(days), periodChanged ? "draft" : sprint.phase, now(), sprint.id);
    return resolveSprint(ctx.db, id);
  });
}
export interface ConfigureScrumWorkspaceInput extends SprintMutation {
  enabled: boolean; problem: string; productGoal: string; priorityRationale: string;
}
const MUTATION_KEYS = ["expectedVersion", "requestKey"];
function human(ctx: OpCtx): void {
  if (isLlm(ctx)) throw new NodError("FORBIDDEN_FOR_LLM", "このSprint操作は人だけが行えます");
}
function workspace(db: Database, key: string) {
  const ws = findWorkspace(db, key);
  if (!ws) throw new NodError("NOT_FOUND", `Workspace ${key} は登録されていません`);
  return ws;
}
function checkVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new NodError("STALE_REVISION", "版が更新されています。最新の内容を確認してください", { expectedVersion: expected, actualVersion: actual });
}
// ローカルDBの変更と再送用結果を一緒に保存する。外部実行用operationとは別の境界。
function mutate<T>(ctx: OpCtx, target: string, operation: string, input: SprintMutation, apply: () => T): T {
  sprintVersion(input.expectedVersion);
  sprintText(input.requestKey, "requestKey");
  const inputHash = sprintHash({ actor: ctx.actor, input });
  return tx(ctx.db, () => {
    const prior = ctx.db.query("SELECT input_hash,result FROM sprint_mutation_receipts WHERE target=? AND operation=? AND request_key=?")
      .get(target, operation, input.requestKey) as { input_hash: string; result: string } | null;
    if (prior) {
      if (prior.input_hash !== inputHash) throw new NodError("IDEMPOTENCY_CONFLICT", "同じrequestKeyに異なる入力を送信できません");
      return JSON.parse(prior.result) as T;
    }
    const result = apply();
    ctx.db.query("INSERT INTO sprint_mutation_receipts VALUES(?,?,?,?,?,?)").run(target, operation, input.requestKey, inputHash, JSON.stringify(result), now());
    return result;
  });
}
export function getScrumWorkspace(db: Database, key: string): ScrumWorkspace {
  const ws = workspace(db, key);
  const row = db.query("SELECT * FROM scrum_workspaces WHERE workspace_id=?").get(ws.id) as {
    enabled: number; problem: string; product_goal: string; priority_rationale: string; version: number; updated_at: string;
  } | null;
  return { workspaceId: ws.id, enabled: row?.enabled === 1, problem: row?.problem ?? null,
    productGoal: row?.product_goal ?? null, priorityRationale: row?.priority_rationale ?? null, version: row?.version ?? 0, updatedAt: row?.updated_at ?? null };
}
export function configureScrumWorkspace(ctx: OpCtx, key: string, input: ConfigureScrumWorkspaceInput): ScrumWorkspace {
  human(ctx);
  sprintObject(input, [...MUTATION_KEYS, "enabled", "problem", "productGoal", "priorityRationale"]);
  if (typeof input.enabled !== "boolean") invalidSprint("enabledは真偽値で指定してください");
  const problem = sprintText(input.problem, "問題"), goal = sprintText(input.productGoal, "プロダクト目標"), rationale = sprintText(input.priorityRationale, "優先順位の根拠");
  const ws = workspace(ctx.db, key);
  return mutate(ctx, `workspace:${ws.id}`, "configure", input, () => {
    const current = getScrumWorkspace(ctx.db, ws.key);
    checkVersion(current.version, input.expectedVersion);
    ctx.db.query(`INSERT INTO scrum_workspaces(workspace_id,enabled,problem,product_goal,priority_rationale,version,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET enabled=excluded.enabled,problem=excluded.problem,
      product_goal=excluded.product_goal,priority_rationale=excluded.priority_rationale,version=excluded.version,updated_at=excluded.updated_at`)
      .run(ws.id, input.enabled ? 1 : 0, problem, goal, rationale, current.version + 1, now());
    return getScrumWorkspace(ctx.db, ws.key);
  });
}

export interface AddSprintCandidateInput extends SprintMutation { issueRef: string }
export function listSprintCandidates(db: Database, ref: string): SprintItem[] {
  const id = resolveSprint(db, ref).id;
  const rows = db.query("SELECT * FROM sprint_items WHERE sprint_id=? ORDER BY source_issue_key").all(id) as {
    id: string; sprint_id: string; issue_id: number | null; source_issue_key: string; origin: SprintItem["origin"]; snapshot: string;
  }[];
  return rows.map(r => ({ id: r.id, sprintId: r.sprint_id, issueId: r.issue_id, sourceIssueKey: r.source_issue_key, origin: r.origin, snapshot: JSON.parse(r.snapshot) }));
}
function touchSprint(db: Database, id: string): Sprint {
  db.query("UPDATE sprints SET version=version+1,updated_at=? WHERE id=?").run(now(), id);
  return resolveSprint(db, id);
}
export function addSprintCandidate(ctx: OpCtx, ref: string, input: AddSprintCandidateInput): { sprint: Sprint; item: SprintItem } {
  sprintObject(input, [...MUTATION_KEYS, "issueRef"]);
  sprintText(input.issueRef, "Issue");
  const id = resolveSprint(ctx.db, ref).id;
  return mutate(ctx, id, "add-candidate", input, () => {
    const sprint = writableSprint(ctx.db, id);
    checkVersion(sprint.version, input.expectedVersion);
    const issue = findIssueRow(ctx.db, input.issueRef);
    if (issue.workspace_id !== sprint.workspaceId) invalidSprint("候補は同じWorkspaceのIssueを指定してください");
    if (issue.archived_at) throw new NodError("ISSUE_ARCHIVED", "アーカイブ済みIssueは候補へ追加できません");
    const sourceIssueKey = `${issue.ws_key}-${issue.number}`;
    const existing = listSprintCandidates(ctx.db, id).find(item => item.sourceIssueKey === sourceIssueKey);
    if (existing) {
      if (existing.issueId !== issue.id) throw new NodError("TARGET_CHANGED", "元の候補Issueは削除されています。再利用されたIDへ接続しません");
      return { sprint, item: existing };
    }
    const snapshot: SprintItem["snapshot"] = { schemaVersion: 1, capturedAt: now(), statusBasis: "candidate_snapshot",
      workspace: { id: issue.workspace_id, key: issue.ws_key, name: workspace(ctx.db, issue.ws_key).name }, issue: { ...issue },
      labels: (ctx.db.query("SELECT label FROM issue_labels WHERE issue_id=? ORDER BY label").all(issue.id) as {label:string}[]).map(r => r.label),
      project: issue.project_id === null ? null : ctx.db.query("SELECT * FROM projects WHERE id=?").get(issue.project_id) as Record<string, unknown> | null };
    const itemId = crypto.randomUUID();
    ctx.db.query("INSERT INTO sprint_items VALUES(?,?,?,?,?,'candidate')").run(itemId, id, issue.id, sourceIssueKey, JSON.stringify(snapshot));
    return { sprint: touchSprint(ctx.db, id), item: listSprintCandidates(ctx.db, id).find(item => item.id === itemId)! };
  });
}

export interface ProposeSprintPlanInput extends SprintMutation {
  goal: string; verificationMethod: string;
  items: { itemId: string; contribution: string; executionPlan: string }[];
  definitionOfDone: { id: string; text: string }[];
  constraints: SprintPlanConstraints; changeReason: string;
}
export interface SprintPlanResult { sprint: Sprint; plan: SprintPlan }
export function listSprintPlans(db: Database, ref: string): SprintPlan[] {
  const id = resolveSprint(db, ref).id;
  const rows = db.query(`SELECT p.*,c.* FROM sprint_plans p JOIN sprint_plan_contents c ON c.plan_id=p.id WHERE p.sprint_id=? ORDER BY p.revision`).all(id) as {
    id:string; sprint_id:string; revision:number; base_plan_id:string|null; content_hash:string; content:string; change_reason:string;
    created_by:string; created_at:string; agreed_by:string|null; agreed_at:string|null; agreed_hash:string|null; agreement_source:string|null;
  }[];
  return rows.map(r => ({ id:r.id, sprintId:r.sprint_id, revision:r.revision, basePlanId:r.base_plan_id, contentHash:r.content_hash,
    content:JSON.parse(r.content), changeReason:r.change_reason, createdBy:r.created_by, createdAt:r.created_at,
    agreedBy:r.agreed_by, agreedAt:r.agreed_at, agreedHash:r.agreed_hash, agreementSource:r.agreement_source ? JSON.parse(r.agreement_source) : null }));
}
export function getSprintPlan(db: Database, ref: string, planId: string): SprintPlan {
  const plan = listSprintPlans(db, ref).find(p => p.id === planId);
  if (!plan) throw new NodError("NOT_FOUND", "対象Sprintに計画がありません");
  return plan;
}
function planConstraints(value: unknown): SprintPlanConstraints {
  const row = sprintObject(value, ["executionScope", "maxParallel", "notes", "executionTarget", "model", "effort", "executionSettingsPolicy"], "制約");
  if (!Number.isSafeInteger(row.maxParallel) || (row.maxParallel as number) < 1) invalidSprint("並行上限は1以上の整数で指定してください");
  const result: SprintPlanConstraints = { executionScope: sprintText(row.executionScope, "実行範囲"), maxParallel: row.maxParallel as number, notes: sprintText(row.notes, "制約の説明") };
  for (const key of ["executionTarget", "model", "effort"] as const) if (row[key] !== undefined) result[key] = sprintText(row[key], key);
  if (row.executionSettingsPolicy !== undefined) {
    const p = sprintObject(row.executionSettingsPolicy, ["version", "agent", "allowedModels", "allowedEfforts", "allowedTargets"], "継承設定の方針");
    const values = (key: string) => {
      const values = p[key];
      if (!Array.isArray(values) || !values.length || values.length > 64) return invalidSprint("継承設定の許可範囲を指定してください");
      return values.map(v => sprintText(v, key));
    };
    result.executionSettingsPolicy = { version: sprintText(p.version, "方針の版"), agent: sprintText(p.agent, "agent"),
      allowedModels: values("allowedModels"), allowedEfforts: values("allowedEfforts"), allowedTargets: values("allowedTargets") };
  }
  return result;
}
export function proposeSprintPlan(ctx: OpCtx, ref: string, input: ProposeSprintPlanInput): SprintPlanResult {
  sprintObject(input, [...MUTATION_KEYS, "goal", "verificationMethod", "items", "definitionOfDone", "constraints", "changeReason"]);
  const goal = sprintText(input.goal, "ゴール"), verificationMethod = sprintText(input.verificationMethod, "達成確認方法"), changeReason = sprintText(input.changeReason, "変更理由");
  const constraints = planConstraints(input.constraints);
  if (!Array.isArray(input.items)) invalidSprint("itemsは配列で指定してください");
  if (!Array.isArray(input.definitionOfDone) || !input.definitionOfDone.length) invalidSprint("完成の定義を1件以上指定してください");
  const definitionOfDone = input.definitionOfDone.map(value => {
    const row = sprintObject(value, ["id", "text"], "DoD");
    return { id: sprintText(row.id, "DoD ID"), text: sprintText(row.text, "完成条件") };
  });
  if (new Set(definitionOfDone.map(d => d.id)).size !== definitionOfDone.length) invalidSprint("DoD IDが重複しています");
  const selected = input.items.map(value => {
    const row = sprintObject(value, ["itemId", "contribution", "executionPlan"], "採択項目");
    return { itemId: sprintText(row.itemId, "item ID"), contribution: sprintText(row.contribution, "ゴールへの貢献"), executionPlan: sprintText(row.executionPlan, "実行計画") };
  });
  if (new Set(selected.map(item => item.itemId)).size !== selected.length) invalidSprint("item IDが重複しています");
  const id = resolveSprint(ctx.db, ref).id;
  return mutate(ctx, id, "propose", input, () => {
    const sprint = writableSprint(ctx.db, id);
    checkVersion(sprint.version, input.expectedVersion);
    const candidates = listSprintCandidates(ctx.db, id);
    const items = selected.map(item => {
      const candidate = candidates.find(c => c.id === item.itemId);
      if (!candidate) invalidSprint("別のSprintまたは存在しないitemは採択できません");
      if (candidate.issueId === null) throw new NodError("TARGET_CHANGED", "元のIssueは削除されています");
      const issue = findIssueRow(ctx.db, candidate.sourceIssueKey);
      if (issue.id !== candidate.issueId || issue.workspace_id !== sprint.workspaceId || issue.archived_at) throw new NodError("TARGET_CHANGED", "候補のIssueが変更・アーカイブされています");
      return { ...item, requirement: { title: issue.title, description: issue.description } };
    });
    const content: SprintPlanContent = { schemaVersion: 1, goal, verificationMethod,
      period: { startDate:sprint.startDate, endDate:sprint.endDate, timezone:sprint.timezone!, startsAt:sprint.startsAt!, endsAt:sprint.endsAt!, workingDays:sprint.workingDays },
      items, definitionOfDone, constraints };
    const plans = listSprintPlans(ctx.db, id);
    const previous = plans.at(-1);
    const revision = (ctx.db.query("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM sprint_plans WHERE sprint_id=?").get(id) as {revision:number}).revision;
    const planId = crypto.randomUUID(), hash = sprintHash(content);
    ctx.db.query("INSERT INTO sprint_plans(id,sprint_id,revision,content_hash) VALUES(?,?,?,?)").run(planId,id,revision,hash);
    ctx.db.query("INSERT INTO sprint_plan_contents(plan_id,schema_version,base_plan_id,content,change_reason,created_by,created_at) VALUES(?,1,?,?,?,?,?)")
      .run(planId,previous?.id ?? null,JSON.stringify(content),changeReason,ctx.actor,now());
    for (const item of items) ctx.db.query("INSERT INTO sprint_plan_items VALUES(?,?)").run(planId,item.itemId);
    if (sprint.phase !== "active") ctx.db.query("UPDATE sprints SET phase='draft' WHERE id=?").run(id);
    const priorAgreement = plans.find(p => p.contentHash === hash && p.agreedBy === HUMAN_ACTOR && p.agreedAt && p.agreedHash === hash);
    if (priorAgreement) adoptPlan(ctx, sprint, getSprintPlan(ctx.db,id,planId), priorAgreement.agreedAt!, priorAgreement.agreementSource);
    return { sprint: touchSprint(ctx.db,id), plan:getSprintPlan(ctx.db,id,planId) };
  });
}

function checkPlanTarget(db: Database, sprint: Sprint, plan: SprintPlan): void {
  const period = plan.content.period;
  if (period.startDate !== sprint.startDate || period.endDate !== sprint.endDate || period.timezone !== sprint.timezone
    || period.startsAt !== sprint.startsAt || period.endsAt !== sprint.endsAt || JSON.stringify(period.workingDays) !== JSON.stringify(sprint.workingDays)) {
    throw new NodError("TARGET_CHANGED", "期間が計画と異なります。変更した期間で新しい計画を提案してください");
  }
  if (sprintHash(plan.content) !== plan.contentHash) throw new NodError("TARGET_CHANGED", "計画のhashが内容と一致しません");
  const candidates = listSprintCandidates(db, sprint.id);
  for (const item of plan.content.items) {
    const candidate = candidates.find(c => c.id === item.itemId);
    if (!candidate || candidate.issueId === null) throw new NodError("TARGET_CHANGED", "採択対象の元Issueがありません");
    const row = findIssueRow(db, candidate.sourceIssueKey);
    if (row.id !== candidate.issueId || row.workspace_id !== sprint.workspaceId || row.archived_at
      || row.title !== item.requirement.title || row.description !== item.requirement.description) {
      throw new NodError("TARGET_CHANGED", "採択対象の要求が変わっています。新しい計画へ反映してください");
    }
  }
}
function adoptPlan(ctx: OpCtx, sprint: Sprint, plan: SprintPlan, agreedAt: string, source: SprintPlan["agreementSource"]): void {
  checkPlanTarget(ctx.db, sprint, plan);
  const occupied = ctx.db.query("SELECT item_id FROM sprint_attempts WHERE sprint_id=? AND occupied=1 AND parent_attempt_id IS NULL").all(sprint.id) as { item_id: string }[];
  if (occupied.some(a => !plan.content.items.some(item => item.itemId === a.item_id))) {
    throw new NodError("EXECUTION_OWNED", "未解決の試行を採択から除外できません。元Task・Dispatchと引継ぎを照合してください");
  }
  if (occupied.length > plan.content.constraints.maxParallel) {
    throw new NodError("PARALLEL_LIMIT", "未解決の予約を下回る並行上限へ変更できません");
  }
  ctx.db.query("UPDATE sprint_plans SET agreed_by=?,agreed_at=?,agreed_hash=? WHERE id=?").run(HUMAN_ACTOR,agreedAt,plan.contentHash,plan.id);
  ctx.db.query("UPDATE sprint_plan_contents SET agreement_source=? WHERE plan_id=?").run(source ? JSON.stringify(source) : null,plan.id);
  ctx.db.query("UPDATE sprints SET adopted_plan_id=?,goal=?,definition_of_done=?,phase=? WHERE id=?").run(plan.id,plan.content.goal,JSON.stringify(plan.content.definitionOfDone),sprint.phase === "active" ? "active" : "ready",sprint.id);
}
export interface AcceptSprintPlanInput extends SprintMutation {
  contentHash: string; agreementSource?: { source: string; quote: string };
}
export function acceptSprintPlan(ctx: OpCtx, ref: string, planId: string, input: AcceptSprintPlanInput): SprintPlanResult {
  human(ctx);
  sprintObject(input, [...MUTATION_KEYS,"contentHash","agreementSource"]);
  sprintText(input.contentHash,"計画hash");
  let source: SprintPlan["agreementSource"] = null;
  if (input.agreementSource !== undefined) {
    const row = sprintObject(input.agreementSource,["source","quote"],"合意出典");
    source = { source:sprintText(row.source,"合意の出典"), quote:sprintText(row.quote,"合意原文") };
  }
  const id = resolveSprint(ctx.db,ref).id;
  return mutate(ctx,id,`accept:${planId}`,input,() => {
    const sprint = writableSprint(ctx.db,id);
    checkVersion(sprint.version,input.expectedVersion);
    const plan = getSprintPlan(ctx.db,id,planId);
    if (plan.contentHash !== input.contentHash || listSprintPlans(ctx.db,id).at(-1)?.id !== planId) throw new NodError("STALE_REVISION","対象の計画版とhashが最新の提案に一致しません");
    checkPlanTarget(ctx.db,sprint,plan);
    if (sprint.adoptedPlanId === plan.id && plan.agreedBy === HUMAN_ACTOR && plan.agreedHash === plan.contentHash) return {sprint,plan};
    adoptPlan(ctx,sprint,plan,now(),source);
    return {sprint:touchSprint(ctx.db,id),plan:getSprintPlan(ctx.db,id,plan.id)};
  });
}
export interface SprintPlanningStatus {
  sprintId: string; sprintVersion: number; observedAt: string; canStart: boolean;
  reason: { code: string; message: string } | null;
}
// 開始操作と同じ条件を読取で示す。予約・実行の許可にはしない。
export function getSprintPlanningStatus(db: Database, ref: string, clock: SprintClock = {}): SprintPlanningStatus {
  return tx(db, () => {
    const sprint = resolveSprint(db, ref);
    const instant = clock.now ?? new Date();
    if (!Number.isFinite(instant.getTime())) invalidSprint("時計の時刻が不正です");
    let reason: SprintPlanningStatus["reason"] = null;
    try { assertSprintCanActivate(db, sprint, { now: instant }); }
    catch (error) { if (!(error instanceof NodError)) throw error; reason = { code: error.code, message: error.message }; }
    return { sprintId: sprint.id, sprintVersion: sprint.version, observedAt: instant.toISOString(), canStart: reason === null, reason };
  });
}
function assertSprintCanActivate(db: Database, sprint: Sprint, clock: SprintClock): Date {
  if (sprint.phase !== "ready" || !sprint.adoptedPlanId) throw new NodError("NOT_ACCEPTED","合意済みの計画を確認してから開始してください");
  const plan = getSprintPlan(db,sprint.id,sprint.adoptedPlanId);
  if (plan.agreedBy !== HUMAN_ACTOR || !plan.agreedAt || plan.agreedHash !== plan.contentHash) throw new NodError("NOT_ACCEPTED","対象の版とhashへの人の合意がありません");
  checkPlanTarget(db,sprint,plan);
  const config = db.query("SELECT enabled FROM scrum_workspaces WHERE workspace_id=?").get(sprint.workspaceId!) as {enabled:number}|null;
  if (!config?.enabled) throw new NodError("SCRUM_DISABLED","WorkspaceのSprint運用が無効です");
  const instant = clock.now ?? new Date();
  if (!Number.isFinite(instant.getTime())) invalidSprint("時計の時刻が不正です");
  if (instant.getTime() < Date.parse(sprint.startsAt!)) throw new NodError("SPRINT_NOT_ACTIVE","Sprintの開始期間前です");
  if (instant.getTime() >= Date.parse(sprint.endsAt!)) throw new NodError("SPRINT_EXPIRED","Sprintの期間は終了しています");
  if (db.query("SELECT id FROM sprints WHERE workspace_id=? AND phase='active'").get(sprint.workspaceId!)) throw new NodError("SPRINT_ALREADY_ACTIVE","同じWorkspaceで実行中のSprintがあります");
  return instant;
}

export function activateSprint(ctx: OpCtx, ref: string, input: SprintMutation, clock: SprintClock = {}): Sprint {
  human(ctx);
  sprintObject(input,MUTATION_KEYS);
  const id = resolveSprint(ctx.db,ref).id;
  return mutate(ctx,id,"activate",input,() => {
    const sprint = writableSprint(ctx.db,id);
    checkVersion(sprint.version,input.expectedVersion);
    const instant = assertSprintCanActivate(ctx.db, sprint, clock);
    ctx.db.query("UPDATE sprints SET phase='active',activated_at=? WHERE id=?").run(instant.toISOString(),id);
    return touchSprint(ctx.db,id);
  });
}
export interface CancelSprintInput extends SprintMutation { reason: string }
export interface EndSprintInput extends SprintMutation { reason: string }
export function endSprint(ctx: OpCtx, ref: string, input: EndSprintInput, clock: SprintClock = {}): Sprint {
  human(ctx);
  sprintObject(input,[...MUTATION_KEYS,"reason"]);
  const reason = sprintText(input.reason,"終了理由");
  const id = resolveSprint(ctx.db,ref).id;
  return mutate(ctx,id,"end",input,() => {
    const sprint = writableSprint(ctx.db,id);
    checkVersion(sprint.version,input.expectedVersion);
    if (sprint.phase !== "active") throw new NodError("INVALID_STATE","進行中のSprintだけを終了できます");
    const instant = clock.now ?? new Date();
    if (!Number.isFinite(instant.getTime())) invalidSprint("時計の時刻が不正です");
    if (!sprint.endsAt || instant.getTime() < Date.parse(sprint.endsAt)) throw new NodError("SPRINT_NOT_EXPIRED","期限前に区切る場合は中止してください");
    ctx.db.query("UPDATE sprints SET phase='ended' WHERE id=?").run(id);
    saveSprintClosure(ctx.db,id,"ended",reason,instant.toISOString());
    return touchSprint(ctx.db,id);
  });
}
export function cancelSprint(ctx: OpCtx, ref: string, input: CancelSprintInput, clock: SprintClock = {}): Sprint {
  human(ctx);
  sprintObject(input,[...MUTATION_KEYS,"reason"]);
  const reason = sprintText(input.reason,"中止理由"), id = resolveSprint(ctx.db,ref).id;
  return mutate(ctx,id,"cancel",input,() => {
    const sprint = writableSprint(ctx.db,id);
    checkVersion(sprint.version,input.expectedVersion);
    ctx.db.query("UPDATE sprints SET phase='canceled',canceled_at=?,cancel_reason=? WHERE id=?").run((clock.now ?? new Date()).toISOString(),reason,id);
    return touchSprint(ctx.db,id);
  });
}
