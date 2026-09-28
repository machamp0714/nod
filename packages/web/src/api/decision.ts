import { apiFetch, type FetchLike } from "./client";
import { issuePath } from "./query-keys";
import type { Inbox, Issue } from "./types";

// 判断の画面（Inbox、Reviews、Triage）が使う API。形は C の計画の API の表に従う。
export type DecisionAction =
  | { op: "answer"; issueId: string; questionId: number; answer: string }
  | { op: "approve"; issueId: string }
  | { op: "reject"; issueId: string; reason: string }
  | { op: "accept"; issueId: string }
  | { op: "decline"; issueId: string; reason?: string }
  | { op: "duplicate"; issueId: string; original: string }
  | { op: "snooze"; issueId: string; until: string };

export function fetchInbox(fetchImpl?: FetchLike): Promise<Inbox> {
  return apiFetch<Inbox>("/inbox", {}, fetchImpl);
}

export function fetchTriage(fetchImpl?: FetchLike): Promise<Issue[]> {
  return apiFetch<Issue[]>("/triage", {}, fetchImpl);
}

// 本文を持たない操作（approve、accept）も {} を送る。server は空か {} を受け付ける
export function actionRequest(action: DecisionAction): { path: string; body: Record<string, unknown> } {
  const path = issuePath(action.issueId, action.op);
  switch (action.op) {
    case "answer":
      return { path, body: { answer: action.answer.trim(), questionId: action.questionId } };
    case "reject":
      return { path, body: { reason: action.reason.trim() } };
    case "decline": {
      const reason = action.reason?.trim();
      return { path, body: reason ? { reason } : {} };
    }
    case "duplicate":
      return { path, body: { original: action.original.trim() } };
    case "snooze":
      return { path, body: { until: action.until.trim() } };
    case "approve":
    case "accept":
      return { path, body: {} };
  }
}

// 応答は使わない（H の useApiMutation がクエリを無効にして読み直す）ため unknown で受ける
export function postDecision(action: DecisionAction, fetchImpl?: FetchLike): Promise<unknown> {
  const { path, body } = actionRequest(action);
  return apiFetch<unknown>(path, { method: "POST", body }, fetchImpl);
}
