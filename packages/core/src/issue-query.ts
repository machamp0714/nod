import type { Database, SQLQueryBindings } from "bun:sqlite";
import { NodError } from "./errors";
import type {
  ActivityItem,
  AgentState,
  DocumentRef,
  Issue,
  Plan,
  PlanStep,
  Question,
  Status,
  StepStatus,
} from "./types";

export interface IssueRow {
  id: number;
  workspace_id: number;
  number: number;
  title: string;
  description: string | null;
  status: Status;
  priority: number;
  assignee: string | null;
  agent_state: AgentState | null;
  parent_id: number | null;
  project_id: number | null;
  snoozed_until: string | null;
  pr_url: string | null;
  branch: string | null;
  worktree: string | null;
  plan_source: string | null;
  close_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  closed_at: string | null;
  ws_key: string;
  parent_key: string | null;
  parent_number: number | null;
  project_name: string | null;
  labels: string | null;
  blocked_by: string | null;
  question_total: number;
  question_answered: number;
}

export const ISSUE_SELECT = `SELECT i.*, w.key AS ws_key, pw.key AS parent_key, pi.number AS parent_number, pr.name AS project_name,
  (SELECT group_concat(l.label, char(10)) FROM issue_labels l WHERE l.issue_id = i.id) AS labels,
  (SELECT group_concat(blocker_id, char(10)) FROM (
    SELECT bw.key || '-' || b.number AS blocker_id FROM relations r
    JOIN issues b ON b.id = r.from_id JOIN workspaces bw ON bw.id = b.workspace_id
    WHERE r.to_id = i.id AND r.type = 'blocks' AND b.status NOT IN ('done', 'canceled')
    ORDER BY bw.key, b.number
  )) AS blocked_by,
  (SELECT count(*) FROM questions q WHERE q.issue_id = i.id) AS question_total,
  (SELECT count(*) FROM questions q WHERE q.issue_id = i.id AND q.answer IS NOT NULL) AS question_answered
FROM issues i
JOIN workspaces w ON w.id = i.workspace_id
LEFT JOIN issues pi ON pi.id = i.parent_id
LEFT JOIN workspaces pw ON pw.id = pi.workspace_id
LEFT JOIN projects pr ON pr.id = i.project_id`;

// 着手できる Issue の条件のうち、担当者に関係しないもの（web の Ready）。? には現在時刻を渡す
export const READY_WHERE = `(i.status = 'todo'
  AND (i.snoozed_until IS NULL OR i.snoozed_until <= ?)
  AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.issue_id = i.id AND q.answer IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM relations r JOIN issues b ON b.id = r.from_id
    WHERE r.to_id = i.id AND r.type = 'blocks' AND b.status NOT IN ('done', 'canceled')
  ))`;

const REF_RE = /^([A-Za-z0-9]{2,6})-(\d+)$/;

export function formatIssueId(key: string, number: number): string {
  return `${key}-${number}`;
}

export function findIssueRow(db: Database, ref: string): IssueRow {
  const m = REF_RE.exec(ref.trim());
  if (!m) throw new NodError("INVALID_ARGS", `${ref} は Issue の ID ではありません（例: API-12）`);
  const row = db
    .query(`${ISSUE_SELECT} WHERE w.key = ? AND i.number = ?`)
    .get((m[1] ?? "").toUpperCase(), Number(m[2])) as IssueRow | null;
  if (!row) throw new NodError("NOT_FOUND", `Issue ${ref} はありません`);
  return row;
}

export function issueRowById(db: Database, id: number): IssueRow {
  const row = db.query(`${ISSUE_SELECT} WHERE i.id = ?`).get(id) as IssueRow | null;
  if (!row) throw new NodError("NOT_FOUND", `Issue（内部 ID ${id}）はありません`);
  return row;
}

export function toIssue(r: IssueRow): Issue {
  return {
    id: formatIssueId(r.ws_key, r.number),
    workspace: r.ws_key,
    number: r.number,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority,
    assignee: r.assignee,
    agentState: r.agent_state,
    parentId: r.parent_key && r.parent_number !== null ? formatIssueId(r.parent_key, r.parent_number) : null,
    project: r.project_id !== null && r.project_name !== null ? { id: r.project_id, name: r.project_name } : null,
    labels: r.labels ? r.labels.split("\n").sort() : [],
    blockedBy: r.blocked_by ? r.blocked_by.split("\n") : [],
    questionCount: { answered: r.question_answered, total: r.question_total },
    snoozedUntil: r.snoozed_until,
    prUrl: r.pr_url,
    branch: r.branch,
    worktree: r.worktree,
    closeReason: r.close_reason,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    closedAt: r.closed_at,
  };
}

export function selectIssues(db: Database, where: string, params: SQLQueryBindings[]): Issue[] {
  return (db.query(`${ISSUE_SELECT} ${where}`).all(...params) as IssueRow[]).map(toIssue);
}

export interface QuestionRow {
  id: number;
  issue_id: number;
  question: string;
  asked_by: string;
  asked_at: string;
  answer: string | null;
  answered_by: string | null;
  answered_at: string | null;
}

export function toQuestion(r: QuestionRow, issueId: string): Question {
  return {
    id: r.id,
    issueId,
    question: r.question,
    askedBy: r.asked_by,
    askedAt: r.asked_at,
    answer: r.answer,
    answeredBy: r.answered_by,
    answeredAt: r.answered_at,
  };
}

export function loadPlan(db: Database, issueId: number, source: string | null): Plan {
  const tasks = db.query("SELECT id, title, status FROM plan_tasks WHERE issue_id = ? ORDER BY position").all(issueId) as {
    id: number;
    title: string;
    status: StepStatus;
  }[];
  const steps = db.query("SELECT title, status FROM plan_steps WHERE task_id = ? ORDER BY position");
  return {
    source,
    tasks: tasks.map((t) => ({ title: t.title, status: t.status, steps: steps.all(t.id) as PlanStep[] })),
  };
}

export function loadDocuments(db: Database, target: { issueId: number } | { projectId: number }): DocumentRef[] {
  const [column, id] = "issueId" in target ? ["issue_id", target.issueId] : ["project_id", target.projectId];
  return db
    .query(
      `SELECT d.id, d.path, d.title, d.kind FROM documents d JOIN document_links l ON l.document_id = d.id WHERE l.${column} = ? ORDER BY d.id`,
    )
    .all(id) as DocumentRef[];
}

export function loadActivity(db: Database, issueId: number): ActivityItem[] {
  const events = (
    db.query("SELECT actor, type, data, created_at FROM events WHERE issue_id = ? ORDER BY id").all(issueId) as {
      actor: string;
      type: string;
      data: string;
      created_at: string;
    }[]
  ).map((e): ActivityItem => ({ kind: "event", at: e.created_at, actor: e.actor, type: e.type, data: JSON.parse(e.data) }));
  const comments = (
    db.query("SELECT author, body, created_at FROM comments WHERE issue_id = ? ORDER BY id").all(issueId) as {
      author: string;
      body: string;
      created_at: string;
    }[]
  ).map((c): ActivityItem => ({ kind: "comment", at: c.created_at, actor: c.author, body: c.body }));
  const questions = (
    db.query("SELECT * FROM questions WHERE issue_id = ? ORDER BY id").all(issueId) as QuestionRow[]
  ).map(
    (q): ActivityItem => ({
      kind: "question",
      at: q.asked_at,
      actor: q.asked_by,
      question: q.question,
      answer: q.answer,
      answeredBy: q.answered_by,
      answeredAt: q.answered_at,
    }),
  );
  // sort は安定なので、同じ時刻なら events、comments、questions の順に並ぶ
  return [...events, ...comments, ...questions].sort((a, b) => a.at.localeCompare(b.at));
}
