export interface SprintRecordLink {
  kind: "document" | "issue" | "url" | "sprint-plan";
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

export interface SprintRetrospectiveContent {
  wentWell: string;
  difficulties: string;
  improvements: string;
  nextActions: string;
  links: SprintRecordLink[];
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
export type SprintRetrospectiveRecord = SprintRecordBase & { kind: "retrospective"; content: SprintRetrospectiveContent };
export type SprintRecord = SprintOutcomeRecord | SprintFeedbackRecord | SprintRetrospectiveRecord;

export type AddSprintRecordInput = {
  requestKey: string;
  correctsRecordId?: string;
} & ({ kind: "outcome"; content: Partial<SprintOutcomeContent> } | { kind: "feedback"; content: Partial<SprintFeedbackContent> } | { kind: "retrospective"; content: Partial<SprintRetrospectiveContent> });
