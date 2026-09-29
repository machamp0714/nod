export interface Workspace {
  id: number;
  key: string;
  name: string;
  path: string;
  color: string;
  createdAt: string;
}

export const STATUSES = [
  "triage",
  "backlog",
  "needs_clarification",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const;
export type Status = (typeof STATUSES)[number];

export const AGENT_STATES = ["working", "awaiting_input", "error", "done"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export const STEP_STATUSES = ["pending", "doing", "done", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const DOC_KINDS = ["spec", "plan", "doc"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export type RelationType = "blocks" | "related" | "duplicate";

export interface Issue {
  id: string;
  workspace: string;
  number: number;
  title: string;
  description: string | null;
  status: Status;
  priority: number;
  assignee: string | null;
  agentState: AgentState | null;
  parentId: string | null;
  project: { id: number; name: string } | null;
  labels: string[];
  blockedBy: string[]; // 未完了の直接ブロック元の Issue ID
  questionCount: { answered: number; total: number }; // 未決事項（確認依頼）の決定数と総数
  snoozedUntil: string | null;
  prUrl: string | null;
  branch: string | null;
  worktree: string | null;
  closeReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  closedAt: string | null;
}

export interface PlanStep {
  title: string;
  status: StepStatus;
}

export interface PlanTask {
  title: string;
  status: StepStatus;
  steps: PlanStep[];
}

export interface Plan {
  source: string | null;
  tasks: PlanTask[];
}

export const PROJECT_STATUSES = ["planned", "started", "completed", "canceled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface UpdateProjectInput {
  status: ProjectStatus;
}

export interface Project {
  id: number;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary extends Project {
  total: number;
  done: number;
  agents: { working: number; awaitingInput: number; awaitingReview: number; error: number };
}

export interface ProjectDetail extends ProjectSummary {
  issues: Issue[];
  documents: DocumentRef[];
}

export interface DocumentRef {
  id: number;
  path: string;
  title: string;
  kind: DocKind;
}

export interface DocumentContent extends DocumentRef {
  content: string | null; // ファイルが見つからない、または読めないときは null
}

export interface DocumentIssueLink {
  id: string;
  title: string;
  status: Status;
}

export interface DocumentProjectLink {
  id: number;
  name: string;
}

// Document 側から見たリンク先。DocumentContent に加算する
export interface DocumentDetail extends DocumentContent {
  createdAt: string;
  issues: DocumentIssueLink[];
  projects: DocumentProjectLink[];
}

export interface DocumentSummary extends DocumentRef {
  createdAt: string;
  issues: string[]; // リンク先の Issue ID
  projects: DocumentProjectLink[];
}

export interface Question {
  id: number;
  issueId: string;
  question: string;
  askedBy: string;
  askedAt: string;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
}

export interface Comment {
  id: number;
  issueId: string;
  author: string;
  body: string;
  createdAt: string;
  // スレッドの親なら null。返信は1階層で、親は常にスレッドの親
  parentId: number | null;
  // スレッドの親が解決済みなら日時と解決した人。未解決と返信は null
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface CommentReply {
  id: number;
  at: string;
  actor: string;
  body: string;
}

export type ActivityItem =
  | { kind: "event"; at: string; actor: string; type: string; data: Record<string, unknown> }
  | {
      kind: "comment";
      id: number;
      at: string;
      actor: string;
      body: string;
      replies: CommentReply[];
      resolvedAt: string | null;
      resolvedBy: string | null;
    }
  | {
      kind: "question";
      at: string;
      actor: string;
      question: string;
      answer: string | null;
      answeredBy: string | null;
      answeredAt: string | null;
    };

export interface Relations {
  blocks: string[];
  blockedBy: string[];
  related: string[];
  duplicateOf: string[];
  duplicates: string[];
}

export interface InboxQuestion extends Question {
  issueTitle: string;
  workspace: string;
  branch: string | null;
  worktree: string | null;
}

export interface ReviewReport { actor: string; at: string; body: string }
export interface ReviewIssue extends Issue {
  reviewSummary: string | null;
  reviewReport: ReviewReport | null;
  reviewSubmittedAt: string | null;
}
export interface AcceptTriageInput {
  projectRef?: string | null;
  priority?: number;
  addLabels?: string[];
  removeLabels?: string[];
}
export interface IssueDocumentRef extends DocumentRef {
  attachedBy: string | null;
  attachedAt: string | null;
}

export interface Inbox {
  questions: InboxQuestion[];
  reviews: ReviewIssue[];
}

export interface IssueDetail extends Issue {
  plan: Plan;
  documents: IssueDocumentRef[];
  children: Issue[];
  relations: Relations;
  questions: Question[]; // 回答済みも含めたすべての確認依頼（未決事項）。id の順
  openQuestions: Question[];
  activity: ActivityItem[];
}

export interface Template {
  id: number;
  name: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}
