import type { Issue } from "./types";

export type SprintPhase = "imported" | "draft" | "ready" | "active" | "ended" | "canceled";

export interface Sprint {
  id: string;
  number: number;
  workspaceId: number | null;
  name: string;
  phase: SprintPhase;
  startDate: string;
  endDate: string;
  timezone: string | null;
  startsAt: string | null;
  endsAt: string | null;
  adoptedPlanId: string | null;
  goal: string | null;
  definitionOfDone: string | null;
  outcome: string | null;
  legacyCycleId: number | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  workingDays: number[];
  workspaceSnapshot: { id: number; key: string; name: string } | null;
  activatedAt: string | null;
  canceledAt: string | null;
  cancelReason: string | null;
  replansSprintId: string | null;
}

export interface SprintItem {
  id: string;
  sprintId: string;
  issueId: number | null;
  sourceIssueKey: string;
  origin: "imported" | "candidate";
  snapshot: {
    schemaVersion: number;
    capturedAt: string;
    statusBasis: "migration_snapshot" | "candidate_snapshot";
    labels: string[];
    project: Record<string, unknown> | null;
    workspace: { id: number; key: string; name: string };
    issue: { id: number; title: string; description: string | null; status: string; [key: string]: unknown };
  };
}

export interface SprintLegacyEvent {
  original: { id: number; issue_id: number; type: string; data: string; actor: string; created_at: string };
  association: "recorded" | "ambiguous";
}

export interface SprintDetail extends Sprint {
  plans: SprintPlan[];
  items: SprintItem[];
  events: SprintLegacyEvent[];
  evidence: {sourceIssueId:number;sourceIssueKey:string;snapshot:SprintItem["snapshot"]}[];
  legacy: { schemaVersion: number; cycle: Record<string, unknown>; cadence: Record<string, unknown> | null; capturedAt: string; statusBasis: "migration_snapshot" } | null;
}

export interface SprintPlanConstraints {
  executionScope: string;
  maxParallel: number;
  notes: string;
  executionTarget?: string;
  model?: string;
  effort?: string;
}
export interface SprintPlanContent {
  schemaVersion: 1;
  goal: string;
  verificationMethod: string;
  period: { startDate: string; endDate: string; timezone: string; startsAt: string; endsAt: string; workingDays: number[] };
  items: { itemId: string; contribution: string; executionPlan: string; requirement: { title: string; description: string | null } }[];
  definitionOfDone: { id: string; text: string }[];
  constraints: SprintPlanConstraints;
}
export interface SprintPlan {
  id: string; sprintId: string; revision: number; basePlanId: string | null;
  contentHash: string; content: SprintPlanContent; changeReason: string;
  createdBy: string; createdAt: string;
  agreedBy: string | null; agreedAt: string | null; agreedHash: string | null;
  agreementSource: { source: string; quote: string } | null;
}

// 期間との関連を確定できない旧履歴。所属・採択とは分けて保持する。
export interface SprintUnresolvedHistory {
  capturedAt: string | null;
  issues: {
    sourceIssueId: number;
    sourceIssueKey: string;
    snapshot: SprintItem["snapshot"];
    events: SprintLegacyEvent["original"][];
  }[];
}

export type LegacyCycleResolution =
  | { kind: "imported"; sprintId: string }
  | { kind: "deleted" }
  | { kind: "not_found" };

export interface SprintClock { now?: Date }

export interface SprintReference extends Pick<Sprint, "id" | "number" | "name" | "workspaceId" | "phase"> {
  association: "imported" | "adopted";
}

export interface CurrentSprintIssue extends Issue {}

export interface CurrentSprintResolution {
  sprints: Sprint[];
  issues: CurrentSprintIssue[];
}

export interface SprintAnalytics extends Omit<import("./types").CycleAnalytics, "cycleId" | "burnup" | "scopeAdded"> {
  sprintId: string;
  number: number;
  statusBasis: "migration_snapshot" | "live_adopted";
  capturedAt: string | null;
  scopeAdded: number | null;
  burnup: {date: string; scope: number | null; started: number | null; completed: number | null; unknown: number}[];
  history: {
    timezone: string | null;
    timezoneBasis: "recorded" | "requested" | "unknown";
    unavailableReason: "timezone_unknown" | "not_recorded" | null;
    recordedEventIds: number[];
    ambiguousEventIds: number[];
  };
}
