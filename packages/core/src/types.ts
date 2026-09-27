export interface Workspace {
  id: number;
  key: string;
  name: string;
  path: string;
  createdAt: string;
}

export const STATUSES = ["triage", "backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
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

export interface DocumentRef {
  id: number;
  path: string;
  title: string;
  kind: DocKind;
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
}

export type ActivityItem =
  | { kind: "event"; at: string; actor: string; type: string; data: Record<string, unknown> }
  | { kind: "comment"; at: string; actor: string; body: string }
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

export interface IssueDetail extends Issue {
  plan: Plan;
  documents: DocumentRef[];
  children: Issue[];
  relations: Relations;
  openQuestions: Question[];
  activity: ActivityItem[];
}
