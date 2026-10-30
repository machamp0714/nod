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

export interface SprintRecord {
  id: string;
  sprintId: string;
  kind: "outcome";
  content: SprintOutcomeContent;
  recordedBy: string;
  recordedAt: string;
  correctsRecordId: string | null;
}

export interface AddSprintRecordInput {
  requestKey: string;
  kind: SprintRecord["kind"];
  content: Partial<SprintOutcomeContent>;
  correctsRecordId?: string;
}
