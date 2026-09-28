import { NodError, toNodError } from "@nod/core";

// core の NodError のコードから HTTP ステータスへの対応。表にないコードは 500 とする
export const ERROR_STATUS: Record<string, number> = {
  INVALID_ARGS: 400,
  INVALID_STEP: 400,
  NO_TASKS: 400,
  FORBIDDEN_FOR_LLM: 403,
  FORBIDDEN_ORIGIN: 403,
  NOT_FOUND: 404,
  FILE_NOT_FOUND: 404,
  NOT_IN_TRIAGE: 409,
  NOT_IN_REVIEW: 409,
  NOT_IN_PROGRESS: 409,
  NOT_ACCEPTED: 409,
  ISSUE_CLOSED: 409,
  NEEDS_CLARIFICATION: 409,
  NO_OPEN_QUESTION: 409,
  ASSIGNED_TO_OTHER: 409,
  AWAITING_ANSWER: 409,
  BLOCKED: 409,
  VIEW_EXISTS: 409,
  PROJECT_EXISTS: 409,
  KEY_TAKEN: 409,
  NAME_TAKEN: 409,
  DB_BUSY: 503,
  SCHEMA_TOO_NEW: 500,
};

// CLI の --json と同じ形
export interface ErrorBody {
  error: { code: string; message: string };
}

export function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
  const e = toNodError(err);
  if (e instanceof NodError) {
    return { status: ERROR_STATUS[e.code] ?? 500, body: { error: { code: e.code, message: e.message } } };
  }
  console.error(e);
  const message = e instanceof Error ? e.message : String(e);
  return { status: 500, body: { error: { code: "INTERNAL", message } } };
}
