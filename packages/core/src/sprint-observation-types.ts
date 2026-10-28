import type { SprintExecutionIdentity } from "./sprint-execution-types";
import type { SprintSelfMetadata } from "./sprint-self-metadata";
import type { SprintPlanConstraints } from "./sprint-types";

export interface SprintOrcaStatusMessage {
  id: string; runId: string; fromHandle: string; type: string; receivedAt: string; payload: unknown;
}
export interface SprintOrcaHostObservation {
  runId: string; taskId: string; dispatchId: string; active: boolean; exactWorker: boolean;
  identity: SprintExecutionIdentity; cwd: string | null; agent: string | null;
  liveness: "live" | "exited" | "unverifiable"; source: string; observedAt: string;
  livenessSource?: string | null; livenessObservedAt?: string | null;
}
export interface SprintHostObservation {
  messageId: string; inputHash: string; result: "matched" | "mismatched" | "unavailable";
  reason: { code: string; message: string } | null; verifiedAt: string;
  metadata: SprintSelfMetadata; independent: SprintOrcaHostObservation | null;
  selfHost: { identity: SprintExecutionIdentity; cwd: string; source: string; observedAt: string };
  identityFingerprint: string | null; settingsFingerprint: string | null;
  confirmationId: string | null; authorizationId: string | null;
}
export interface SprintSettingsRequirement {
  mode: "explicit" | "inherit"; planId: string; planHash: string; agent: string;
  model: string | null; effort: string | null; target: string | null; fingerprint: string;
  policy?: SprintPlanConstraints["executionSettingsPolicy"];
}
export interface SprintStartConfirmation {
  id: string; createdAt: string; messageId: string; identityFingerprint: string; settingsFingerprint: string;
}
export interface SprintStartAuthorization {
  id: string; confirmationId: string; operationId: string; generation: number; authorizedAt: string;
  identityFingerprint: string; settingsFingerprint: string;
}
