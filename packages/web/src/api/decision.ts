import { apiFetch, type FetchLike } from "./client";
import { issuePath } from "./query-keys";
import type { AcceptTriageInput, Inbox, Issue, TriageProposal, TriageSuggestions } from "./types";

// 判断の画面（Inbox、Reviews、Triage）が使う API。形は C の計画の API の表に従う。
export type DecisionAction =
  | { op: "answer"; issueId: string; questionId: number; answer: string }
  | { op: "approve"; issueId: string }
  // delegate を付けると、理由を LLM への対応依頼として記録する（#58）
  | { op: "reject"; issueId: string; reason: string; delegate?: "review_fix" | "rebase" }
  | { op: "accept"; issueId: string; input?: AcceptTriageInput }
  | { op: "decline"; issueId: string; reason?: string }
  | { op: "duplicate"; issueId: string; original: string }
  | { op: "snooze"; issueId: string; until: string };

export function fetchInbox(fetchImpl?: FetchLike, opts: { includeAnswered?: boolean } = {}): Promise<Inbox> {
  return apiFetch<Inbox>(opts.includeAnswered ? "/inbox?includeAnswered=true" : "/inbox", {}, fetchImpl);
}

export function fetchTriage(fetchImpl?: FetchLike): Promise<Issue[]> {
  return apiFetch<Issue[]>("/triage", {}, fetchImpl);
}

// 重複・ラベル・担当の候補（読み取りのみ）
export function fetchTriageSuggestions(id: string, fetchImpl?: FetchLike): Promise<TriageSuggestions> {
  return apiFetch<TriageSuggestions>(`/triage/${encodeURIComponent(id)}/suggestions`, {}, fetchImpl);
}

// LLM の提案（#62、読み取りのみ）。記録は CLI の nod triage propose だけで行う
// Triage 中の Issue ごとの LLM の提案者の数（#125）。提案の無い Issue はキーを持たない
export function fetchTriageProposalCounts(fetchImpl?: FetchLike): Promise<Record<string, number>> {
  return apiFetch<Record<string, number>>("/triage/proposal-counts", {}, fetchImpl);
}

export function fetchTriageProposals(id: string, fetchImpl?: FetchLike): Promise<TriageProposal[]> {
  return apiFetch<TriageProposal[]>(`/triage/${encodeURIComponent(id)}/proposals`, {}, fetchImpl);
}

// 本文を持たない操作（approve、accept）も {} を送る。server は空か {} を受け付ける
export function actionRequest(action: DecisionAction): { path: string; body: Record<string, unknown> } {
  const path = issuePath(action.issueId, action.op);
  switch (action.op) {
    case "answer":
      return { path, body: { answer: action.answer.trim(), questionId: action.questionId } };
    case "reject":
      return { path, body: action.delegate ? { reason: action.reason.trim(), delegate: action.delegate } : { reason: action.reason.trim() } };
    case "decline": {
      const reason = action.reason?.trim();
      return { path, body: reason ? { reason } : {} };
    }
    case "duplicate":
      return { path, body: { original: action.original.trim() } };
    case "snooze":
      return { path, body: { until: action.until.trim() } };
    case "accept":
      return { path, body: { ...action.input } };
    case "approve":
      return { path, body: {} };
  }
}

// 応答は使わない（H の useApiMutation がクエリを無効にして読み直す）ため unknown で受ける
export function postDecision(action: DecisionAction, fetchImpl?: FetchLike): Promise<unknown> {
  const { path, body } = actionRequest(action);
  return apiFetch<unknown>(path, { method: "POST", body }, fetchImpl);
}
