import type { SprintClock } from "./sprint-types";
import type { SprintHostObservation, SprintOrcaHostObservation, SprintOrcaStatusMessage, SprintSettingsRequirement,
  SprintStartAuthorization, SprintStartConfirmation } from "./sprint-observation-types";

export interface SprintRunAuthority {
  runId: string; caller: string; coordinator: string; consumerGeneration: number;
  runtimeId: string; source: string; observedAt: string;
  callerIdentity?: string;
}
export interface SprintExecutionPlacement { worktree: string; agent: string; on?: string; model?: string; effort?: string }
export interface SprintExecutionIdentity {
  runtimeId: string | null; incarnationId: string | null; terminal: string | null;
  remoteRuntimeEpoch: string | null;
}
export interface SprintExecutionReceipt {
  runId: string | null; requestId: string | null; taskId: string | null; dispatchId: string | null;
  requested: { agent: string | null; model: string | null; effort: string | null } | null;
  effective: { agent: string | null; model: string | null; effort: string | null } | null;
  identity: SprintExecutionIdentity | null; source: string; receivedAt: string;
  notification?: { messageId: string; toHandle: string; accepted: true };
}
export interface SprintSession {
  schemaVersion: 1; id: string; sprintId: string; generation: number; runId: string;
  actor: string; caller: string; consumerGeneration: number; runtimeId: string;
  planId: string; planHash: string; state: "active" | "handover";
  requestKey: string; inputHash: string; observedAt: string; source: string;
  handover: { requestKey: string; caller: string | null } | null;
  callerIdentity?: string;
  unreconciledOwnership?: SprintExistingOwnership[];
  planHistory?: { planId: string; planHash: string; reconciledAt: string }[];
}
export interface SprintExistingOwnership {
  itemId: string; sourceIssueKey: string; issueId: number;
  assignee: string | null; status: string; worktree: string | null; branch: string | null;
  observedAt: string; source: string; reason: { code: string; message: string };
}
export interface PrepareSprintExecutionInput {
  sessionId: string; generation: number; requestKey: string; itemId: string;
  actor: string; spec: string; placement: SprintExecutionPlacement; parentAttemptId?: string;
}
export interface SprintAttempt {
  schemaVersion: 1; id: string; sprintId: string; itemId: string; sourceIssueKey: string;
  parentAttemptId: string | null; actor: string; sessionId: string; generation: number;
  planId: string; planHash: string; decisionRefs: string[];
  runId: string; taskId: string | null; dispatchId: string | null;
  placement: SprintExecutionPlacement; phase: "reserved" | "awaiting_confirmation" | "unknown" | "start_authorized" | "implementing";
  occupied: true; canStart: boolean; reason: { code: string; message: string };
  identity: SprintExecutionIdentity | null; observation: { source: string; observedAt: string } | null;
  planHistory?: { planId: string; planHash: string; reconciledAt: string }[];
  settingsRequirement?: SprintSettingsRequirement;
  hostObservation?: SprintHostObservation;
  observationHistory?: SprintHostObservation[];
  startConfirmation?: SprintStartConfirmation;
  startAuthorization?: SprintStartAuthorization;
  startedReport?: { messageId: string; authorizationId: string; reportedAt: string; verifiedAt: string };
  executionLiveness?: { verdict: "live" | "exited" | "unverifiable"; source: string; observedAt: string };
}
export interface SprintExecutionOperation {
  schemaVersion: 1; id: string; sprintId: string; attemptId: string;
  kind: "task_create" | "worker_start" | "worker_begin"; requestKey: string; inputHash: string;
  sessionId: string; generation: number; caller: string; callerIdentity: string | null; runtimeId: string; runId: string;
  state: "prepared" | "sending" | "confirmed" | "unknown" | "failed";
  requestId: string | null; receipt: SprintExecutionReceipt | null;
  input: { spec: string; placement: SprintExecutionPlacement; taskId: string | null; parentTaskId: string | null };
  start?: { dispatchId: string; authorization: SprintStartAuthorization; identity: SprintExecutionIdentity };
  reason: { code: string; message: string } | null;
}
export interface SprintExecutionSnapshot {
  schemaVersion: 1;
  id: string; sessionId: string; generation: number; executionVersion: number;
  planId: string; planHash: string; authority: SprintRunAuthority | null;
  resolved: boolean; reason: { code: string; message: string } | null;
  bindings: { operationId: string; receipt: SprintExecutionReceipt }[];
}
export interface SprintExecutionState {
  sprintId: string; session: SprintSession | null; executionVersion: number;
  attempts: SprintAttempt[]; operations: SprintExecutionOperation[];
  occupied: number; reserved: number; canStart: boolean; stale: boolean;
  unreconciledOwnership: SprintExistingOwnership[];
  quarantined: { operationId: string; generation: number; reason: string; receipt: SprintExecutionReceipt }[];
  nextActions: { description: string; argv: string[]; input?: SprintSessionContext & { requestKey?: string } }[];
}
export interface SprintOrcaTask { runId: string; taskId: string; spec: string | null; parentTaskId: string | null }
export interface SprintOrcaWorker {
  runId: string; taskId: string; dispatchId: string; identity: SprintExecutionIdentity;
  liveness: "live" | "exited" | "unverifiable"; source: string; observedAt: string;
}
export interface SprintOrcaInventory {
  tasks: SprintOrcaTask[]; workers: SprintOrcaWorker[]; complete: boolean;
}
export interface SprintRequestObservation {
  state: "absent" | "pending" | "completed"; requestId: string;
  receipt: SprintExecutionReceipt | null; source: string; observedAt: string;
  recovery?: { originalInactive: true; evidence: string; argv: string[] };
}
// 外部境界だけを差し替える。DBの予約・所有・世代判定は常に同じ公開coreを通す。
export interface SprintOrcaAdapter {
  authority(runId: string): Promise<SprintRunAuthority>;
  inventory?(runId: string, targets?: { taskId: string | null; dispatchId: string | null }[]): Promise<SprintOrcaInventory>;
  send?(operation: SprintExecutionOperation, retryRequestId?: string): Promise<SprintExecutionReceipt>;
  request?(requestId: string): Promise<SprintRequestObservation>;
  // 実際のOrca受信箱と、保存したDispatchの独立host観測。payloadによる代替は禁止。
  status?(messageId: string, runId: string): Promise<SprintOrcaStatusMessage | null>;
  host?(attempt: SprintAttempt): Promise<SprintOrcaHostObservation>;
}
export interface SprintSessionInput { expectedVersion: number; requestKey: string; runId: string }
export interface SprintSessionContext { sessionId: string; generation: number }
export type SprintExecutionClock = SprintClock;

export class SprintOrcaMutationError extends Error {
  constructor(readonly requestId: string | null) { super("Orcaの操作結果を確認できません"); }
}
