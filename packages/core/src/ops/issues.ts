import { type IssueQuery, validateIssueQuery } from "../issue-filter";
import { getTemplate } from "./templates";
import { enterClarification } from "../clarification";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { addComment, recordEvent, threadRootId } from "../events";
import {
  READY_WHERE,
  type CommentRow,
  findIssueRow,
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
import { type Comment, type Issue, type IssueDetail, type RelationType, type Relations, type Status, STATUSES } from "../types";
import { resolveProject } from "./projects";

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

export interface CreateIssueInput {
  workspaceId: number;
  title: string;
  description?: string;
  template?: string; // テンプレートの名前。本文を説明の初期値にする（description と同時には使えない）
  projectRef?: string;
  parentRef?: string;
  discoveredFromRef?: string;
  priority?: number;
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
  return tx(ctx.db, () => {
    const source = input.discoveredFromRef === undefined ? null : findIssueRow(ctx.db, requireText(input.discoveredFromRef, "起票元"));
    const parent = input.parentRef ? findIssueRow(ctx.db, input.parentRef) : null;
    const project = input.projectRef ? resolveProject(ctx.db, input.projectRef) : null;
    const description = input.template !== undefined ? getTemplate(ctx.db, input.template).body : (input.description ?? null);
    return insertIssue(ctx, {
      workspaceId: input.workspaceId,
      title: input.title,
      description,
      priority: input.priority ?? 0,
      parentId: parent?.id ?? null,
      projectId: project?.id ?? null,
      labels: input.labels ?? [],
      origin: source ? { discovered_from: formatIssueId(source.ws_key, source.number) } : {},
    });
  });
}

interface NewIssueRow {
  workspaceId: number;
  title: string;
  description: string | null;
  priority: number;
  parentId: number | null;
  projectId: number | null;
  labels: string[];
  origin: Record<string, string>; // created の event に残す由来（発見元、複製元）
}

// 起票と複製で共通の行の追加。番号の発行と初期ステータス（LLM は Triage）をここで決める。呼び出し側の tx の中で使う
function insertIssue(ctx: OpCtx, input: NewIssueRow): Issue {
  const ws = ctx.db.query("SELECT id, next_number FROM workspaces WHERE id = ?").get(input.workspaceId) as {
    id: number;
    next_number: number;
  } | null;
  if (!ws) throw new NodError("NOT_FOUND", "Workspace がありません");
  const status: Status = isLlm(ctx) ? "triage" : "todo";
  const ts = now();
  ctx.db.query("UPDATE workspaces SET next_number = next_number + 1 WHERE id = ?").run(ws.id);
  const { lastInsertRowid } = ctx.db
    .query(
      `INSERT INTO issues (workspace_id, number, title, description, status, priority, parent_id, project_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ws.id, ws.next_number, input.title, input.description, status, input.priority, input.parentId, input.projectId, ctx.actor, ts, ts);
  const id = Number(lastInsertRowid);
  for (const label of new Set(input.labels)) {
    ctx.db.query("INSERT INTO issue_labels (issue_id, label) VALUES (?, ?)").run(id, label);
  }
  recordEvent(ctx.db, id, ctx.actor, "created", { status, ...input.origin });
  return toIssue(issueRowById(ctx.db, id));
}

// 既存の Issue から新しい Issue を作る。複製するのはタイトル・説明・Project・ラベル・優先度だけで、
// 担当・進行状態・親子・関係・PR・実行場所・計画・Documents・質問・コメント・Activity は引き継がない。元の Issue は変えない
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
  labels?: string[];
  ready?: boolean;
  query?: string;
  blocked?: boolean;
}

// Workspace、Project、ラベルの条件。Ready と Needs Clarification の件数もこの範囲で数える
function scopeWhere(db: Database, filter: ListIssuesFilter): { where: string[]; params: SQLQueryBindings[] } {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (filter.workspaceId !== undefined) {
    where.push("i.workspace_id = ?");
    params.push(filter.workspaceId);
  }
  if (filter.workspaceKeys?.length) {
    where.push(`w.key IN (${filter.workspaceKeys.map(() => "?").join(", ")})`);
    params.push(...filter.workspaceKeys.map((k) => k.toUpperCase()));
  }
  if (filter.projectRef) {
    where.push("i.project_id = ?");
    params.push(resolveProject(db, filter.projectRef).id);
  }
  for (const label of filter.labels ?? []) {
    where.push("EXISTS (SELECT 1 FROM issue_labels l WHERE l.issue_id = i.id AND l.label = ?)");
    params.push(label);
  }
  if (filter.blocked !== undefined) {
    where.push(`${filter.blocked ? "" : "NOT "}EXISTS (
      SELECT 1 FROM relations r JOIN issues b ON b.id = r.from_id
      WHERE r.to_id = i.id AND r.type = 'blocks' AND b.status NOT IN ('done', 'canceled')
    )`);
  }
  return { where, params };
}

// SQLite の lower は非ASCIIで Web と異なるため、検索だけは同じ JavaScript の判定を使う。
function matchesQuery(issue: Issue, query: string | undefined): boolean {
  const needle = query?.trim().toLowerCase() ?? "";
  return !needle || [issue.id, issue.title, issue.description ?? ""].some((text) => text.toLowerCase().includes(needle));
}

export function listIssues(db: Database, filter: ListIssuesFilter = {}): Issue[] {
  const { where, params } = scopeWhere(db, filter);
  const statuses = filter.statuses?.length ? filter.statuses : STATUSES.filter((s) => s !== "done" && s !== "canceled");
  where.push(`i.status IN (${statuses.map(() => "?").join(", ")})`);
  params.push(...statuses);
  if (filter.ready) {
    where.push(READY_WHERE);
    params.push(now());
  }
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
    labels: q.label,
    ready: q.ready,
    query: q.q,
    blocked: q.blocked,
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

export function getIssue(db: Database, ref: string): IssueDetail {
  const row = findIssueRow(db, ref);
  const issue = toIssue(row);
  const questions = (
    db.query("SELECT * FROM questions WHERE issue_id = ? ORDER BY id").all(row.id) as QuestionRow[]
  ).map((q) => toQuestion(q, issue.id));
  return {
    ...issue,
    plan: loadPlan(db, row.id, row.plan_source),
    documents: loadIssueDocuments(db, row.id),
    children: selectIssues(db, "WHERE i.parent_id = ? ORDER BY i.number", [row.id]),
    relations: loadRelations(db, row.id),
    questions,
    openQuestions: questions.filter((q) => q.answer === null),
    activity: loadActivity(db, row.id),
  };
}

export interface UpdateIssueInput {
  title?: string;
  description?: string | null;
  priority?: number;
  status?: Status;
  assignee?: string | null;
  parentRef?: string | null;
  projectRef?: string | null;
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
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    if (input.title !== undefined) setColumn(ctx, row, "title", input.title);
    if (input.description !== undefined) setColumn(ctx, row, "description", input.description);
    if (input.priority !== undefined) setColumn(ctx, row, "priority", input.priority);
    if (input.assignee !== undefined) setColumn(ctx, row, "assignee", input.assignee);
    if (input.parentRef !== undefined) {
      const parent = input.parentRef ? findIssueRow(ctx.db, input.parentRef) : null;
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
    if (input.status !== undefined) {
      if (input.reason !== undefined && (input.status === "done" || input.status === "canceled")) {
        setColumn(ctx, row, "close_reason", input.reason);
      }
      const changed = setColumn(ctx, row, "status", input.status, input.reason ? { reason: input.reason } : {});
      enterClarification(ctx, row);
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
    const row = findIssueRow(ctx.db, ref);
    const parentId = opts.replyTo === undefined ? null : threadRootId(ctx, row, opts.replyTo);
    return addComment(ctx, row, body, parentId);
  });
}

// スレッドを解決済み・未解決に切り替える。人だけが行え、状態が変わったときだけ event を残す
export function resolveThread(ctx: OpCtx, ref: string, commentId: number, resolved: boolean): Comment {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM はコメントのスレッドを解決済み・未解決にできません。判断は me に依頼してください");
  }
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
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
    };
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
  tx(ctx.db, () => addRelation(ctx, findIssueRow(ctx.db, ref), findIssueRow(ctx.db, only[1]), only[0]));
  return getIssue(ctx.db, ref);
}
