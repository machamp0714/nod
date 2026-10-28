import type { SprintExecutionState, SprintSessionContext } from "./sprint-execution-types";
import type { SprintHostObservation, SprintOrcaStatusMessage } from "./sprint-observation-types";

export interface SprintOrcaDelivery {
  runId: string; deliveryId: string | null; messages: SprintOrcaStatusMessage[]; count: number;
  source: string; observedAt: string;
}
export interface SprintNotificationResult {
  id: string; logicalKey: string; inputHash: string; kind: "observation" | "question" | "request_rejected" | "completion" | "notice";
  attemptId: string; observation?: SprintHostObservation; savedAt: string;
  question?: { text: string }; response?: { body: string | null };
  notice?: { type: string; body: string | null; phase: string | null };
  completion?: { outcome: "succeeded" | "failed"; body: string | null; filesModified: string[]; reportPath: string | null;
    state: "unknown" | "settled"; settlement: SprintOrcaSettlement | null; nextOwner: string | null;
    releaseOperation?: SprintNotificationReleaseOperation;
    ownershipRevision?: number;
    ownership: { state: "pending" | "assigned" | "sending" | "unknown" | "released"; operationId?: string; caller?: string; generation?: number;
      requestId?: string | null; receipt?: SprintOrcaReleaseReceipt | null;
      history?: { caller: string | null; requestId: string | null; receipt: SprintOrcaReleaseReceipt | null }[] } };
}
export interface SprintNotificationReleaseOperation {
  operationId: string; inputHash: string; sessionId: string; generation: number; caller: string;
  callerIdentity: string | null; runtimeId: string; target: { runId: string; dispatchId: string };
  state: "sending" | "confirmed" | "unknown"; requestId: string | null; receipt: SprintOrcaReleaseReceipt | null;
  revision: number;
  history: { operationId: string; revision: number; generation: number; caller: string; state: "sending" | "confirmed" | "unknown";
    requestId: string | null; receipt: SprintOrcaReleaseReceipt | null }[];
  reconciliation?: SprintNotificationRequestObservation;
}
export interface SprintNotificationRequestObservation {
  requestId: string; state: "absent" | "pending" | "completed"; method: string | null;
  runtimeId: string | null; source: string; observedAt: string; release?: SprintOrcaReleaseReceipt;
  reply?: SprintOrcaReplyReceipt & { runId: string; dispatchId: string };
  ack?: NonNullable<SprintNotificationAckOperation["receipt"]> & { runId: string };
}
export interface SprintNotificationReception {
  messageId: string; resultId: string | null; inputHash: string; receivedAt: string;
  reason: { code: string; message: string } | null;
  reply?: { operationId: string; state: "sending" | "confirmed" | "unknown"; body: string; caller: string; generation: number;
    target: { runId: string; messageId: string }; inputHash: string; sessionId: string; runtimeId: string; callerIdentity: string | null;
    requestId: string | null; receipt: SprintOrcaReplyReceipt | null;
    reconciliation?: SprintNotificationRequestObservation;
    history: { caller: string; generation: number; requestId: string | null; state: "sending" | "confirmed" | "unknown"; receipt: SprintOrcaReplyReceipt | null }[] };
}
export interface SprintOrcaReplyReceipt {
  questionId: string; answerMessageId: string; body: string; status: "answered";
  requestId: string | null; source: string; observedAt: string;
}
export interface SprintNotificationInput extends SprintSessionContext {
  answers?: { messageId: string; body: string }[];
  ownership?: { dispatchId: string; action: "coordinator" | "release" }[];
}
export interface SprintOrcaSettlement {
  runId: string; taskId: string; dispatchId: string; activeDispatchId: string | null;
  taskStatus: string | null; dispatchStatus: string | null; outcome: "succeeded" | "failed" | null;
  completedAt: string | null; source: string; observedAt: string;
}
export interface SprintOrcaReleaseReceipt {
  dispatchId: string; state: string; reason?: string | null; processAction: string | null; requestId: string | null; source: string; observedAt: string;
}
export interface SprintNotificationDelivery {
  deliveryId: string; messageIds: string[]; acknowledged: boolean;
  rows: { messageId: string | null; resultId: string | null; reason: { code: string; message: string } | null }[];
  reason: { code: string; message: string } | null;
  ackOperation?: SprintNotificationAckOperation;
}
export interface SprintNotificationAckOperation {
  operationId: string; inputHash: string; sessionId: string; generation: number; caller: string;
  callerIdentity: string | null; runtimeId: string; target: { runId: string; deliveryId: string };
  state: "sending" | "confirmed" | "unknown"; requestId: string | null;
  reconciliation?: SprintNotificationRequestObservation;
  receipt: { acknowledged: string | null; requestId: string | null; source: string | null; observedAt: string | null;
    nextDeliveryId: string | null; nextCount: number } | null;
  history: { generation: number; caller: string; requestId: string | null; state: "sending" | "confirmed" | "unknown";
    receipt: SprintNotificationAckOperation["receipt"] }[];
}
export interface SprintNotificationState {
  results: SprintNotificationResult[]; receptions: SprintNotificationReception[];
  conflicts: { messageId: string; inputHash: string; logicalKey: string | null; existingResultId: string | null;
    reason: { code: string; message: string }; savedAt: string }[];
  quarantined: { messageId: string; fromHandle: string; runId: string; reason: { code: string; message: string };
    source: string; observedAt: string; references: { operationId: string | null; requestId: string | null; generation: number | null } }[];
  deliveries: SprintNotificationDelivery[]; execution: SprintExecutionState;
}
