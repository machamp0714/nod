// core の公開型の写し。web は core の型を import type だけで使う（spec の決定）。
// A の時点では core が main にないため、CLI 計画の core の types.ts から写している。
// B で core に同じ型が揃ったら、このファイルの中身を
//   export type { Status, Issue, ... } from "@nod/core";
// に置き換える。「B で core に足す」と書いたものは、CLI 計画の core になく、B で足す前提のもの。

export type Status =
  | "triage"
  | "backlog"
  | "needs_clarification" // B で core に足す
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "canceled";

export type AgentState = "working" | "awaiting_input" | "error" | "done";
export type StepStatus = "pending" | "doing" | "done" | "skipped";
export type DocKind = "spec" | "plan" | "doc";
export type RelationType = "blocks" | "related" | "duplicate";
export type ProjectStatus = "planned" | "started" | "completed" | "canceled";

export interface Workspace {
  id: number;
  key: string;
  name: string;
  path: string;
  createdAt: string;
}

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
  questions: Question[]; // B で core に足す（未決事項の「決定数 / 総数」に回答済みの質問も要るため）
  activity: ActivityItem[];
}

export interface InboxQuestion extends Question {
  issueTitle: string;
  workspace: string;
  branch: string | null;
  worktree: string | null;
}

export interface Inbox {
  questions: InboxQuestion[];
  reviews: Issue[];
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
  agents: { working: number; awaitingInput: number; error: number };
  workspaces: string[]; // B で core に足す（Projects の一覧の Workspace の列）
}

export interface ProjectDetail extends ProjectSummary {
  issues: Issue[];
  documents: DocumentRef[];
}

// B で core に足す（views テーブル）
export interface View {
  id: number;
  name: string;
  color: string;
  filter: Record<string, string>;
  position: number;
}
