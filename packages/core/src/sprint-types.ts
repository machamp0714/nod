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
  // 自動引継ぎで結んだ前Sprint。一度結んだら選び直さない。
  rolloverFromSprintId: string | null;
  // 開始した主体。自動開始は SPRINT_ROLLOVER_ACTOR。人の開始と既存行は null。
  activatedBy: string | null;
}

export type SprintLink = Pick<Sprint, "id" | "number" | "name" | "phase">;

export interface SprintItem {
  id: string;
  sprintId: string;
  issueId: number | null;
  sourceIssueKey: string;
  // candidateはnod上で登録したitem。所属かどうかはmember・associationで読む。
  origin: "imported" | "candidate";
  addedBy: string | null;
  addedAt: string | null;
  // 自動引継ぎで所属にしたitemの、前Sprint側のitem。
  rolloverFromItemId: string | null;
  member: boolean;
  // 所属の由来。重なるときは imported、added、adopted の順。候補だけ（所属外）はnull。
  association: "imported" | "adopted" | "added" | null;
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
  closureRecord: SprintClosureRecord | null;
  rolloverFrom: SprintLink | null;
  rolloverTo: SprintLink | null;
  plans: SprintPlan[];
  items: SprintItem[];
  events: SprintLegacyEvent[];
  evidence: {sourceIssueId:number;sourceIssueKey:string;snapshot:SprintItem["snapshot"]}[];
  legacy: { schemaVersion: number; cycle: Record<string, unknown>; cadence: Record<string, unknown> | null; capturedAt: string; statusBasis: "migration_snapshot" } | null;
}

export interface SprintClosureRecord {
  kind: "ended" | "canceled";
  recordedAt: string;
  reason: string;
  issues: { issueId: string; status: Issue["status"] }[];
  questions: { questionId: number; issueId: string }[];
  // 自動処理による終了のときだけ付ける。手動の終了・中止の記録の形は変えない。
  automation?: "sprint-rollover";
}

export interface SprintPlanConstraints {
  executionSettingsPolicy?: { version: string; agent: string; allowedModels: string[]; allowedEfforts: string[]; allowedTargets: string[] };
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
  association: "imported" | "adopted" | "added";
}

export interface CurrentSprintIssue extends Issue {}

export interface CurrentSprintResolution {
  sprints: Sprint[];
  issues: CurrentSprintIssue[];
}

export interface SprintAnalytics extends Omit<import("./types").CycleAnalytics, "cycleId" | "burnup" | "scopeAdded"> {
  sprintId: string;
  number: number;
  statusBasis: "migration_snapshot" | "live_membership";
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
