export interface SprintRecordLink {
  kind: "document" | "issue" | "url";
  ref: string;
  label?: string;
}

export interface SprintOutcomeContent {
  summary: string;
  howToTry: string;
  tests: string;
  testResult: "passed" | "failed" | "unverified";
  links: SprintRecordLink[];
}

export interface SprintFeedbackContent {
  helpful: string;
  difficulties: string;
  requests: string;
}

interface SprintRecordBase {
  id: string;
  sprintId: string;
  recordedBy: string;
  recordedAt: string;
  correctsRecordId: string | null;
}

export type SprintOutcomeRecord = SprintRecordBase & { kind: "outcome"; content: SprintOutcomeContent };
export type SprintFeedbackRecord = SprintRecordBase & { kind: "feedback"; content: SprintFeedbackContent };
export type SprintRecord = SprintOutcomeRecord | SprintFeedbackRecord;

export type AddSprintRecordInput = {
  requestKey: string;
  correctsRecordId?: string;
} & ({ kind: "outcome"; content: Partial<SprintOutcomeContent> } | { kind: "feedback"; content: Partial<SprintFeedbackContent> });
