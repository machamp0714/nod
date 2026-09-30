import { listIssueAttachments } from "./attachments";
import { instructionsOfIssue } from "./instructions";
import { isSubscribedRow } from "./notifications";
import { deliverDueRemindersIfFree, loadReminder } from "./reminders";
import { type IssueQuery, validateIssueQuery } from "../issue-filter";
import { getTemplate } from "./templates";
import { openQuestionCount } from "../clarification";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { HUMAN_ACTOR, isLlm, now, type OpCtx } from "../ctx";
import { isValidDueDateInput, MIN_DUE_DATE } from "../due-date";
import { tx } from "../db";
import { NodError } from "../errors";
import { addComment, recordEvent, threadRootId } from "../events";
import {
  COMPLETION_CANDIDATE_SQL,
  OPEN_BLOCKER,
  READY_WHERE,
  type CommentRow,
  findIssueRow,
  findWritableIssueRow,
  formatIssueId,
  type IssueRow,
  issueRowById,
  loadActivity,
  loadIssueDocuments,
  loadPlan,
  type QuestionRow,
  selectIssues,
  toIssue,
  toQuestion,
} from "../issue-query";
import { setColumn } from "../mutate";
import { readTriageProposalNotifications } from "../notify";
import { type ActivityItem, type AgentInstruction, type Comment, type Issue, type IssueDetail, type RelationType, type Relations, type Status, STATUSES } from "../types";
import { resolveMilestone } from "./milestones";
import { resolveCycle, resolveCycleInScope } from "./cycles";
import { isNoneRef, validateAssignee } from "../none-ref";
import { resolveProject } from "./projects";
import { DEFAULT_WORK_LOG_KIND, detectSecret, isWorkLogKind, WORK_LOG_KINDS, WORK_LOG_MAX_LENGTH, workLogLength } from "../work-log";

export function getIssueBranchName(db: Database, ref: string): { issueId: string; suggestedBranch: string } {
  const row = findIssueRow(db, ref);
  const issueId = formatIssueId(row.ws_key, row.number);
  return { issueId, suggestedBranch: `nod/${issueId.toLowerCase()}` };
}

export function requireText(value: string | undefined, what: string): string {
  if (!value || !value.trim()) throw new NodError("INVALID_ARGS", `${what}を指定してください`);
  return value;
}

export function validatePriority(p: number): void {
  if (!Number.isInteger(p) || p < 0 || p > 4) {
    throw new NodError("INVALID_ARGS", "優先度は 0〜4 で指定してください（0 = なし、1 = Urgent、2 = High、3 = Medium、4 = Low）");
  }
}

export function validateEstimate(estimate: number): void {
  if (!Number.isInteger(estimate) || estimate < 1 || estimate > 100) {
    throw new NodError("INVALID_ARGS", "見積もりは 1〜100 の整数（ポイント）で指定してください");
  }
}

// 期限は時刻を持たない暦日。タイムゾーンで日付がずれないよう、文字列のまま保存する
export function validateDueDate(dueDate: string): void {
  if (!isValidDueDateInput(dueDate)) {
    throw new NodError("INVALID_ARGS", `${dueDate} は期限として使えません（${MIN_DUE_DATE} 以降の YYYY-MM-DD の日付で指定してください。例: 2026-10-01）`);
  }
}

export interface CreateIssueInput {
  workspaceId: number;
  title: string;
  description?: string;
  template?: string; // テンプレートの名前。本文を説明の初期値にする（description と同時には使えない）
  projectRef?: string;
  milestoneRef?: string; // Milestone の ID か、projectRef の Project の中の名前（Project の指定が要る）
  cycleRef?: string; // Cycle の ID・名前・current（起票先の Workspace のもの）
  parentRef?: string;
  discoveredFromRef?: string;
  priority?: number;
  estimate?: number;
  dueDate?: string;
  labels?: string[];
}

export function createIssue(ctx: OpCtx, input: CreateIssueInput): Issue {
  requireText(input.title, "タイトル");
  if (input.template !== undefined && input.description !== undefined) {
    throw new NodError(
      "INVALID_ARGS",
      "--template と -d は同時に指定できません。雛形の空欄は、起票した後に nod issue update -d で埋めてください",
    );
  }
  if (input.priority !== undefined) validatePriority(input.priority);
  if (input.estimate !== undefined) validateEstimate(input.estimate);
  if (input.dueDate !== undefined) validateDueDate(input.dueDate);
  if (input.milestoneRef !== undefined && !input.milestoneRef.trim()) {
    throw new NodError("INVALID_ARGS", "Milestone を指定してください。付けないときは --milestone を省きます（空文字で外せるのは更新だけです）");
  }
  return tx(ctx.db, () => {
    const source = input.discoveredFromRef === undefined ? null : findIssueRow(ctx.db, requireText(input.discoveredFromRef, "起票元"));
    const parent = input.parentRef ? findWritableIssueRow(ctx.db, input.parentRef) : null;
    const project = input.projectRef ? resolveProject(ctx.db, input.projectRef) : null;
    const milestone = input.milestoneRef ? projectMilestone(ctx.db, project?.id ?? null, input.milestoneRef) : null;
    const cycle = input.cycleRef ? resolveCycle(ctx.db, input.workspaceId, input.cycleRef) : null;
    const description = input.template !== undefined ? getTemplate(ctx.db, input.template).body : (input.description ?? null);
    return insertIssue(ctx, {
      workspaceId: input.workspaceId,
      title: input.title,
      description,
      priority: input.priority ?? 0,
      estimate: input.estimate ?? null,
      dueDate: input.dueDate ?? null,
      parentId: parent?.id ?? null,
      projectId: project?.id ?? null,
      milestoneId: milestone?.id ?? null,
      cycleId: cycle?.id ?? null,
      labels: input.labels ?? [],
      origin: source ? { discovered_from: formatIssueId(source.ws_key, source.number) } : {},
    });
  });
}

export interface NewIssueRow {
  workspaceId: number;
  title: string;
  description: string | null;
  priority: number;
  estimate: number | null;
  dueDate: string | null;
  parentId: number | null;
  projectId: number | null;
  milestoneId?: number | null;
  cycleId?: number | null;
  labels: string[];
  assignee?: string | null; // 起票時の担当。後から変えたときと違い assignee_changed の event は残さない
  status?: Status; // 初期ステータス。省略時は LLM が Triage、人が todo（取り込みでは取り込み元の状態から決める）
  closeReason?: string | null; // done・canceled で作るときの完了・キャンセルの理由（取り込みだけが使う）
  origin: Record<string, string | number>; // created の event に残す由来（発見元、複製元、定期Issue）
}

// 起票・複製・定期Issueで共通の行の追加。番号の発行と初期ステータス（LLM は Triage）をここで決める。呼び出し側の tx の中で使う
export function insertIssue(ctx: OpCtx, input: NewIssueRow): Issue {
  const ws = ctx.db.query("SELECT id, next_number FROM workspaces WHERE id = ?").get(input.workspaceId) as {
    id: number;
    next_number: number;
  } | null;
  if (!ws) throw new NodError("NOT_FOUND", "Workspace がありません");
  validateAssignee(input.assignee);
  const status: Status = input.status ?? (isLlm(ctx) ? "triage" : "todo");
  // 最初から閉じた状態で作る（取り込み）ときは、状態の遷移を経ずに closed_at を作成時刻にする
  const closed = status === "done" || status === "canceled";
  const ts = now();
  ctx.db.query("UPDATE workspaces SET next_number = next_number + 1 WHERE id = ?").run(ws.id);
  const { lastInsertRowid } = ctx.db
    .query(
      `INSERT INTO issues (workspace_id, number, title, description, status, priority, estimate, due_date, parent_id, project_id, milestone_id, cycle_id, assignee, close_reason, closed_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ws.id,
      ws.next_number,
      input.title,
      input.description,
      status,
      input.priority,
      input.estimate,
      input.dueDate,
      input.parentId,
      input.projectId,
      input.milestoneId ?? null,
      input.cycleId ?? null,
      input.assignee ?? null,
      closed ? (input.closeReason ?? null) : null,
      closed ? ts : null,
      ctx.actor,
      ts,
      ts,
    );
  const id = Number(lastInsertRowid);
  for (const label of new Set(input.labels)) {
    ctx.db.query("INSERT INTO issue_labels (issue_id, label) VALUES (?, ?)").run(id, label);
  }
  recordEvent(ctx.db, id, ctx.actor, "created", { status, ...input.origin });
  return toIssue(issueRowById(ctx.db, id));
}

// 既存の Issue から新しい Issue を作る。複製するのはタイトル・説明・Project・ラベル・優先度・見積もりだけで、
// 期限・担当・進行状態・親子・関係・PR・実行場所・計画・Documents・質問・コメント・Activity は引き継がない。元の Issue は変えない
export function copyIssue(ctx: OpCtx, ref: string, opts: { title?: string } = {}): Issue {
  if (opts.title !== undefined) requireText(opts.title, "タイトル");
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    const labels = (ctx.db.query("SELECT label FROM issue_labels WHERE issue_id = ? ORDER BY label").all(row.id) as { label: string }[])
      .map((l) => l.label);
    return insertIssue(ctx, {
      workspaceId: row.workspace_id,
      title: opts.title ?? row.title,
      description: row.description,
      priority: row.priority,
      estimate: row.estimate,
      dueDate: null,
      parentId: null,
      projectId: row.project_id,
      labels,
      origin: { copied_from: formatIssueId(row.ws_key, row.number) },
    });
  });
}

export interface ListIssuesFilter {
  workspaceId?: number;
  workspaceKeys?: string[];
  statuses?: Status[]; // 省くと done と canceled を除く
  projectRef?: string;
  milestone?: string; // Milestone の ID か "none"（Milestone のない Issue）。名前は projectRef を指定したときだけ
  cycleRef?: string; // Cycle の ID か "none"（Cycle のない Issue）。名前・current は Workspace を1つに絞ったときだけ
  labels?: string[];
  ready?: boolean;
  query?: string;
  blocked?: boolean;
  delegated?: boolean;
  assignees?: string[]; // 担当の名前。どれかに合うもの。"none" は未割り当て
  completionCandidate?: boolean; // true で親の完了候補だけにする
  archived?: boolean; // true ならアーカイブ済みだけ。省くとアーカイブ済みを除く
}

// 絞り込みの Workspace（1つに決まるときの Cycle の名前の解決に使う）。絞っていなければ undefined
function scopeWorkspaceIds(db: Database, filter: ListIssuesFilter): number[] | undefined {
  if (filter.workspaceId !== undefined) return [filter.workspaceId];
  if (!filter.workspaceKeys?.length) return undefined;
  const keys = [...new Set(filter.workspaceKeys.map((k) => k.toUpperCase()))];
  return (db.query(`SELECT id FROM workspaces WHERE key IN (${keys.map(() => "?").join(", ")})`).all(...keys) as { id: number }[]).map((r) => r.id);
}

// Workspace、Project、Cycle、ラベル、担当の条件。Ready と Needs Clarification の件数もこの範囲で数える
function scopeWhere(db: Database, filter: ListIssuesFilter): { where: string[]; params: SQLQueryBindings[] } {
  const where: string[] = [filter.archived ? "i.archived_at IS NOT NULL" : "i.archived_at IS NULL"];
  const params: SQLQueryBindings[] = [];
  if (filter.workspaceId !== undefined) {
    where.push("i.workspace_id = ?");
    params.push(filter.workspaceId);
  }
  if (filter.workspaceKeys?.length) {
    where.push(`w.key IN (${filter.workspaceKeys.map(() => "?").join(", ")})`);
    params.push(...filter.workspaceKeys.map((k) => k.toUpperCase()));
  }
  const projectId = filter.projectRef ? resolveProject(db, filter.projectRef).id : undefined;
  if (projectId !== undefined) {
    where.push("i.project_id = ?");
    params.push(projectId);
  }
  if (isNoneRef(filter.milestone)) where.push("i.milestone_id IS NULL");
  else if (filter.milestone !== undefined) {
    // 名前は Project の中でだけ一意なので、名前で絞るときは Project の指定が要る
    if (!/^\d+$/.test(filter.milestone) && projectId === undefined) {
      throw new NodError("INVALID_ARGS", `Milestone を名前（${filter.milestone}）で絞るときは Project も指定してください（ID なら不要）`);
    }
    const milestone = resolveMilestone(db, filter.milestone, projectId);
    if (projectId !== undefined && milestone.project_id !== projectId) {
      throw new NodError("INVALID_ARGS", `Milestone ${filter.milestone}（${milestone.name}）は指定した Project のものではありません`);
    }
    where.push("i.milestone_id = ?");
    params.push(milestone.id);
  }
  if (isNoneRef(filter.cycleRef)) where.push("i.cycle_id IS NULL");
  else if (filter.cycleRef) {
    where.push("i.cycle_id = ?");
    params.push(resolveCycleInScope(db, filter.cycleRef, scopeWorkspaceIds(db, filter)));
  }
  for (const label of filter.labels ?? []) {
    where.push("EXISTS (SELECT 1 FROM issue_labels l WHERE l.issue_id = i.id AND l.label = ?)");
    params.push(label);
  }
  if (filter.assignees?.length) {
    const names = filter.assignees.filter((name) => !isNoneRef(name));
    const conditions = [
      ...(names.length ? [`i.assignee IN (${names.map(() => "?").join(", ")})`] : []),
      ...(names.length < filter.assignees.length ? ["i.assignee IS NULL"] : []),
    ];
    where.push(`(${conditions.join(" OR ")})`);
    params.push(...names);
  }
  if (filter.blocked !== undefined) {
    where.push(`${filter.blocked ? "" : "NOT "}EXISTS (
      SELECT 1 FROM relations r JOIN issues b ON b.id = r.from_id
      WHERE r.to_id = i.id AND r.type = 'blocks' AND ${OPEN_BLOCKER}
    )`);
  }
  return { where, params };
}

// SQLite の lower は非ASCIIで Web と異なるため、検索だけは同じ JavaScript の判定を使う。
function matchesQuery(issue: Issue, query: string | undefined): boolean {
  const needle = query?.trim().toLowerCase() ?? "";
  return !needle || [issue.id, issue.title, issue.description ?? ""].some((text) => text.toLowerCase().includes(needle));
}

// 委任中：担当が LLM（私以外）で、done と canceled 以外。agent_state は問わない。? には HUMAN_ACTOR を渡す
const DELEGATED_WHERE = "(i.assignee IS NOT NULL AND i.assignee <> ? AND i.status NOT IN ('done', 'canceled'))";

export function listIssues(db: Database, filter: ListIssuesFilter = {}): Issue[] {
  const { where, params } = scopeWhere(db, filter);
  // アーカイブ一覧は閉じた Issue が主なので、ステータスを省くとすべてのステータスを出す
  const statuses = filter.statuses?.length
    ? filter.statuses
    : filter.archived
      ? [...STATUSES]
      : STATUSES.filter((s) => s !== "done" && s !== "canceled");
  where.push(`i.status IN (${statuses.map(() => "?").join(", ")})`);
  params.push(...statuses);
  if (filter.ready) {
    where.push(READY_WHERE);
    params.push(now());
  }
  if (filter.delegated) {
    where.push(DELEGATED_WHERE);
    params.push(HUMAN_ACTOR);
  }
  if (filter.completionCandidate) where.push(COMPLETION_CANDIDATE_SQL);
  return selectIssues(db, `WHERE ${where.join(" AND ")} ORDER BY w.key, i.number`, params)
    .filter((issue) => matchesQuery(issue, filter.query));
}

export interface IssueCounts {
  ready: number;
  needsClarification: number;
}

export interface IssueList {
  issues: Issue[];
  counts: IssueCounts;
}

// web の Issue 一覧（Issues、Views、Project 詳細）の読み出し。ステータスを省くとすべてのステータスを返す
export function queryIssues(db: Database, query: IssueQuery): IssueList {
  const q = validateIssueQuery(query);
  const filter: ListIssuesFilter = {
    workspaceKeys: q.workspace,
    statuses: q.status ?? [...STATUSES],
    projectRef: q.project,
    milestone: q.milestone,
    cycleRef: q.cycle,
    labels: q.label,
    ready: q.ready,
    query: q.q,
    blocked: q.blocked,
    delegated: q.delegated,
    assignees: q.assignee,
    archived: q.archived,
  };
  const scope = scopeWhere(db, filter);
  const scopeSql = scope.where.map((w) => ` AND ${w}`).join("");
  const count = (condition: string, conditionParams: SQLQueryBindings[]) =>
    q.q
      ? selectIssues(db, `WHERE ${condition}${scopeSql}`, [...conditionParams, ...scope.params])
          .filter((issue) => matchesQuery(issue, q.q)).length
      : (
          db
            .query(`SELECT count(*) AS n FROM issues i JOIN workspaces w ON w.id = i.workspace_id WHERE ${condition}${scopeSql}`)
            .get(...conditionParams, ...scope.params) as { n: number }
        ).n;
  return {
    issues: listIssues(db, filter),
    counts: {
      ready: count(READY_WHERE, [now()]),
      needsClarification: count("i.status = 'needs_clarification'", []),
    },
  };
}

interface RelationRow {
  type: RelationType;
  key: string;
  number: number;
}

function loadRelations(db: Database, id: number): Relations {
  const outgoing = db
    .query(
      "SELECT r.type AS type, w.key AS key, i.number AS number FROM relations r JOIN issues i ON i.id = r.to_id JOIN workspaces w ON w.id = i.workspace_id WHERE r.from_id = ? ORDER BY r.created_at",
    )
    .all(id) as RelationRow[];
  const incoming = db
    .query(
      "SELECT r.type AS type, w.key AS key, i.number AS number FROM relations r JOIN issues i ON i.id = r.from_id JOIN workspaces w ON w.id = i.workspace_id WHERE r.to_id = ? ORDER BY r.created_at",
    )
    .all(id) as RelationRow[];
  const ids = (rows: RelationRow[], type: RelationType) =>
    rows.filter((r) => r.type === type).map((r) => formatIssueId(r.key, r.number));
  return {
    blocks: ids(outgoing, "blocks"),
    blockedBy: ids(incoming, "blocks"),
    related: [...ids(outgoing, "related"), ...ids(incoming, "related")],
    duplicateOf: ids(outgoing, "duplicate"),
    duplicates: ids(incoming, "duplicate"),
  };
}

// 期限が来たリマインダーは通知に変えてから返す（残ったままだと、設定済みのように見えて届いていない状態になる）
export function getIssue(db: Database, ref: string): IssueDetail {
  deliverDueRemindersIfFree(db);
  const row = findIssueRow(db, ref);
  const issue = toIssue(row);
  const questions = (
    db.query("SELECT * FROM questions WHERE issue_id = ? ORDER BY id").all(row.id) as QuestionRow[]
  ).map((q) => toQuestion(q, issue.id));
  const instructions = instructionsOfIssue(db, row.id);
  return {
    ...issue,
    plan: loadPlan(db, row.id, row.plan_source),
    documents: loadIssueDocuments(db, row.id),
    attachments: listIssueAttachments(db, row.id),
    children: selectIssues(db, "WHERE i.parent_id = ? AND i.archived_at IS NULL ORDER BY i.number", [row.id]),
    relations: loadRelations(db, row.id),
    questions,
    openQuestions: questions.filter((q) => q.answer === null),
    activity: attachInstructions(loadActivity(db, row.id), instructions),
    subscribed: isSubscribedRow(db, row.id),
    reminder: loadReminder(db, row.id),
    pendingInstructions: instructions.filter((i) => i.acknowledgedAt === null),
  };
}

// 追加指示・対応依頼（#51・#58）のコメントに、種類と送信状態を付ける
function attachInstructions(activity: ActivityItem[], instructions: AgentInstruction[]): ActivityItem[] {
  if (instructions.length === 0) return activity;
  const byComment = new Map(instructions.map((i) => [i.commentId, i]));
  return activity.map((item) => {
    const instruction = item.kind === "comment" ? byComment.get(item.id) : undefined;
    return instruction && item.kind === "comment" ? { ...item, instruction } : item;
  });
}

export interface UpdateIssueInput {
  title?: string;
  description?: string | null;
  priority?: number;
  estimate?: number | null; // null で解除
  dueDate?: string | null; // null で解除
  status?: Status;
  assignee?: string | null;
  parentRef?: string | null;
  projectRef?: string | null;
  milestoneRef?: string | null; // Milestone の ID か、Issue の Project の中の名前。null で外す
  cycleRef?: string | null; // Cycle の ID・名前・current（Issue と同じ Workspace のもの）。null で外す
  addLabels?: string[];
  removeLabels?: string[];
  reason?: string;
}

function changeLabels(ctx: OpCtx, row: IssueRow, add: string[], remove: string[]): void {
  const added = [...new Set(add)].filter(
    (l) => ctx.db.query("INSERT OR IGNORE INTO issue_labels (issue_id, label) VALUES (?, ?)").run(row.id, l).changes > 0,
  );
  const removed = [...new Set(remove)].filter(
    (l) => ctx.db.query("DELETE FROM issue_labels WHERE issue_id = ? AND label = ?").run(row.id, l).changes > 0,
  );
  if (added.length === 0 && removed.length === 0) return;
  ctx.db.query("UPDATE issues SET updated_at = ? WHERE id = ?").run(now(), row.id);
  recordEvent(ctx.db, row.id, ctx.actor, "labels_changed", { added, removed });
}

// ancestorId が issueId の祖先（親をたどって届く）なら true
function isAncestor(db: Database, ancestorId: number, issueId: number): boolean {
  const hit = db
    .query(
      `WITH RECURSIVE up(id) AS (
         SELECT parent_id FROM issues WHERE id = ?
         UNION SELECT i.parent_id FROM issues i JOIN up ON i.id = up.id
       )
       SELECT 1 FROM up WHERE id = ?`,
    )
    .get(issueId, ancestorId);
  return hit !== null;
}

// Issue の Project（projectId）の Milestone を ID か名前で引く。Project がない・別の Project のものは INVALID_ARGS
function projectMilestone(db: Database, projectId: number | null, ref: string): { id: number; name: string } {
  if (projectId === null) {
    throw new NodError("INVALID_ARGS", "Project のない Issue には Milestone を付けられません。先に Project を設定してください");
  }
  const milestone = resolveMilestone(db, ref, projectId);
  if (milestone.project_id !== projectId) {
    throw new NodError("INVALID_ARGS", `Milestone ${ref} は Issue の Project のものではありません（別の Project の Milestone は付けられません）`);
  }
  return milestone;
}

// Milestone は Issue と同じ Project のものだけ付けられる。ref を省くと、Project が変わって合わなくなった Milestone を外すだけ
function setMilestone(ctx: OpCtx, row: IssueRow, ref: string | null | undefined): void {
  let target: { id: number; name: string } | null;
  if (ref === undefined) {
    if (row.milestone_id === null) return;
    const current = resolveMilestone(ctx.db, row.milestone_id);
    if (current.project_id === row.project_id) return;
    target = null;
  } else if (ref === null) {
    target = null;
  } else {
    target = projectMilestone(ctx.db, row.project_id, ref);
  }
  const from = row.milestone_id === null ? null : resolveMilestone(ctx.db, row.milestone_id).name;
  setColumn(ctx, row, "milestone_id", target?.id ?? null, { from, to: target?.name ?? null });
}

// 私が足した未決事項が未回答の間、LLM は Issue を needs_clarification から出せない（#170）。人が決める前に着手させないため。
// canceled は止めない。一括編集の失敗一覧は ID と理由を並べて出すため、理由には ID を含めない
const HELD_FOR_HUMAN: Status[] = ["todo", "backlog", "in_progress", "in_review"];

function assertLlmMayLeaveClarification(ctx: OpCtx, row: IssueRow, to: Status): void {
  if (row.status !== "needs_clarification" || !HELD_FOR_HUMAN.includes(to)) return;
  const open = openQuestionCount(ctx.db, row.id, { humanOnly: true });
  if (open === 0) return;
  throw new NodError(
    "FORBIDDEN_FOR_LLM",
    `me の未決事項が ${open} 件未回答のため、LLM は needs_clarification の Issue の状態を変えられません。回答を me に依頼してください`,
  );
}

export function updateIssue(ctx: OpCtx, ref: string, input: UpdateIssueInput): Issue {
  if (input.status === "needs_clarification") {
    throw new NodError(
      "INVALID_ARGS",
      "needs_clarification は確認依頼に応じて自動で切り替わるため、手では変えられません。未決事項は nod issue ask で足してください",
    );
  }
  if (input.status === "done" && isLlm(ctx)) {
    throw new NodError(
      "FORBIDDEN_FOR_LLM",
      "LLM は Issue を done にできません。作業を終えたら nod issue done でレビューに回してください",
    );
  }
  if (input.title !== undefined) requireText(input.title, "タイトル");
  if (input.priority !== undefined) validatePriority(input.priority);
  if (input.estimate != null) validateEstimate(input.estimate);
  if (input.dueDate != null) validateDueDate(input.dueDate);
  validateAssignee(input.assignee);
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    // Triage を出すのは人の判断（受け入れ・却下・重複と人の状態変更）だけ。何かを書く前に拒む
    if (isLlm(ctx) && input.status !== undefined && input.status !== "triage" && row.status === "triage") {
      throw new NodError(
        "FORBIDDEN_FOR_LLM",
        `LLM は Triage にある ${ref} の状態を変えられません。受け入れ・却下は me に依頼するか、nod triage propose で提案してください`,
      );
    }
    if (isLlm(ctx) && input.status !== undefined) assertLlmMayLeaveClarification(ctx, row, input.status);
    if (input.title !== undefined) setColumn(ctx, row, "title", input.title);
    if (input.description !== undefined) setColumn(ctx, row, "description", input.description);
    if (input.priority !== undefined) setColumn(ctx, row, "priority", input.priority);
    if (input.estimate !== undefined) setColumn(ctx, row, "estimate", input.estimate);
    if (input.dueDate !== undefined) setColumn(ctx, row, "due_date", input.dueDate);
    if (input.assignee !== undefined) setColumn(ctx, row, "assignee", input.assignee);
    if (input.parentRef !== undefined) {
      const parent = input.parentRef ? findWritableIssueRow(ctx.db, input.parentRef) : null;
      if (parent?.id === row.id) throw new NodError("INVALID_ARGS", "Issue 自身を親にはできません");
      if (parent && isAncestor(ctx.db, row.id, parent.id)) {
        throw new NodError("INVALID_ARGS", `${input.parentRef} は ${ref} の子孫なので親にはできません（循環します）`);
      }
      setColumn(ctx, row, "parent_id", parent?.id ?? null, {
        from: toIssue(row).parentId,
        to: parent ? formatIssueId(parent.ws_key, parent.number) : null,
      });
    }
    if (input.projectRef !== undefined) {
      const project = input.projectRef ? resolveProject(ctx.db, input.projectRef) : null;
      setColumn(ctx, row, "project_id", project?.id ?? null, { from: row.project_name, to: project?.name ?? null });
    }
    if (input.milestoneRef !== undefined || row.milestone_id !== null) setMilestone(ctx, row, input.milestoneRef);
    if (input.cycleRef !== undefined) {
      const cycle = input.cycleRef ? resolveCycle(ctx.db, row.workspace_id, input.cycleRef) : null;
      setColumn(ctx, row, "cycle_id", cycle?.id ?? null, { from: row.cycle_name, to: cycle?.name ?? null });
    }
    if (input.status !== undefined) {
      if (input.reason !== undefined && (input.status === "done" || input.status === "canceled")) {
        setColumn(ctx, row, "close_reason", input.reason);
      }
      // 手動の移動では needs_clarification に切り替えない（#170）。未回答が残っていても、指定した状態のままにする
      const changed = setColumn(ctx, row, "status", input.status, input.reason ? { reason: input.reason } : {});
      // 手動移動は着手を意味しない。レビュー済みの作業完了だけは保持する。
      if (changed && !(row.agent_state === "done" && (row.status === "in_review" || row.status === "done"))) {
        setColumn(ctx, row, "agent_state", null);
      }
    }
    changeLabels(ctx, row, input.addLabels ?? [], input.removeLabels ?? []);
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

export function commentIssue(ctx: OpCtx, ref: string, body: string, opts: { replyTo?: number } = {}): Comment {
  requireText(body, "本文");
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    const parentId = opts.replyTo === undefined ? null : threadRootId(ctx, row, opts.replyTo);
    return addComment(ctx, row, body, parentId);
  });
}

// 作業ログを種類付きで残す（nod issue log）。種類の省略は経過。長文と既知の形の秘密値は保存せずに拒否する
export function logWork(ctx: OpCtx, ref: string, body: string, opts: { kind?: string } = {}): Comment {
  requireText(body, "本文");
  const kind = opts.kind ?? DEFAULT_WORK_LOG_KIND;
  if (!isWorkLogKind(kind)) {
    throw new NodError("INVALID_ARGS", `作業ログの種類は ${WORK_LOG_KINDS.join("|")} のどれかで指定してください`);
  }
  const length = workLogLength(body);
  if (length > WORK_LOG_MAX_LENGTH) {
    throw new NodError(
      "INVALID_ARGS",
      `作業ログは ${WORK_LOG_MAX_LENGTH} 文字までです（${length} 文字）。長い出力は要点だけを残し、全文は nod doc create で Document にしてください`,
    );
  }
  const secret = detectSecret(body);
  if (secret) {
    throw new NodError("SECRET_DETECTED", `作業ログに${secret}らしき値が含まれるため記録しませんでした。値を伏せて書き直してください`);
  }
  return tx(ctx.db, () => addComment(ctx, findWritableIssueRow(ctx.db, ref), body, null, kind));
}

// スレッドを解決済み・未解決に切り替える。人だけが行え、状態が変わったときだけ event を残す
export function resolveThread(ctx: OpCtx, ref: string, commentId: number, resolved: boolean): Comment {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM はコメントのスレッドを解決済み・未解決にできません。判断は me に依頼してください");
  }
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    const rootId = threadRootId(ctx, row, commentId);
    const current = ctx.db.query("SELECT * FROM comments WHERE id = ?").get(rootId) as CommentRow;
    if ((current.resolved_at !== null) !== resolved) {
      const ts = now();
      ctx.db
        .query("UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE id = ?")
        .run(resolved ? ts : null, resolved ? ctx.actor : null, rootId);
      ctx.db.query("UPDATE issues SET updated_at = ? WHERE id = ?").run(ts, row.id);
      recordEvent(ctx.db, row.id, ctx.actor, resolved ? "comment_thread_resolved" : "comment_thread_reopened", { comment_id: rootId });
    }
    const c = ctx.db.query("SELECT * FROM comments WHERE id = ?").get(rootId) as CommentRow;
    return {
      id: c.id,
      issueId: formatIssueId(row.ws_key, row.number),
      author: c.author,
      body: c.body,
      createdAt: c.created_at,
      parentId: null,
      resolvedAt: c.resolved_at,
      resolvedBy: c.resolved_by,
      logKind: c.log_kind,
    };
  });
}

// アーカイブは status と別の属性で、Issue を既定の一覧・ボード・Inbox・next から外す。人（LLM 以外）だけが行える。
// 子・関係はそのまま残し、アーカイブ済みはブロック元として数えない。すでにアーカイブ済みなら何もしない（自動アーカイブからも呼ぶ）
export function archiveIssue(ctx: OpCtx, ref: string, opts: { reason?: string; automation?: string } = {}): Issue {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は Issue をアーカイブできません。アーカイブは me に依頼してください");
  }
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    if (row.archived_at === null) {
      const ts = now();
      ctx.db.query("UPDATE issues SET archived_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, row.id);
      const data: Record<string, unknown> = opts.reason?.trim() ? { reason: opts.reason } : {};
      if (opts.automation) data.automation = opts.automation;
      recordEvent(ctx.db, row.id, ctx.actor, "archived", data);
      // アーカイブした Triage の Issue は Triage 一覧から外れるので、提案の通知も対応済みにする（#132）
      if (row.status === "triage") readTriageProposalNotifications(ctx.db, row.id);
    }
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

// アーカイブ済みの Issue を元に戻す。status はアーカイブ前のまま。アーカイブされていなければ何もしない
export function unarchiveIssue(ctx: OpCtx, ref: string): Issue {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は Issue を復元できません。復元は me に依頼してください");
  }
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    if (row.archived_at !== null) {
      ctx.db.query("UPDATE issues SET archived_at = NULL, updated_at = ? WHERE id = ?").run(now(), row.id);
      recordEvent(ctx.db, row.id, ctx.actor, "unarchived");
    }
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

export interface RelateInput {
  blocks?: string;
  related?: string;
  duplicateOf?: string;
}

export function addRelation(ctx: OpCtx, from: IssueRow, to: IssueRow, type: RelationType): void {
  if (from.id === to.id) throw new NodError("INVALID_ARGS", "Issue 自身との関係は作れません");
  const { changes } = ctx.db
    .query("INSERT OR IGNORE INTO relations (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)")
    .run(from.id, to.id, type, now());
  if (changes > 0) {
    recordEvent(ctx.db, from.id, ctx.actor, "relation_added", { type, to: formatIssueId(to.ws_key, to.number) });
  }
}

export function relateIssue(ctx: OpCtx, ref: string, rel: RelateInput): IssueDetail {
  const picked: [RelationType, string][] = [];
  if (rel.blocks) picked.push(["blocks", rel.blocks]);
  if (rel.related) picked.push(["related", rel.related]);
  if (rel.duplicateOf) picked.push(["duplicate", rel.duplicateOf]);
  const [only] = picked;
  if (picked.length !== 1 || !only) {
    throw new NodError("INVALID_ARGS", "--blocks、--related、--duplicate-of のどれか1つを指定してください");
  }
  tx(ctx.db, () => addRelation(ctx, findWritableIssueRow(ctx.db, ref), findWritableIssueRow(ctx.db, only[1]), only[0]));
  return getIssue(ctx.db, ref);
}
