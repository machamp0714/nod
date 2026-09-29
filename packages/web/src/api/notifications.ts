import { apiFetch, type FetchLike } from "./client";
import { issuePath } from "./query-keys";
import type { Notification, SubscriptionState } from "./types";

// 購読（#45）と通知（#42）の API
export type NotificationAction =
  | { op: "subscribe"; issueId: string }
  | { op: "unsubscribe"; issueId: string }
  | { op: "read"; ids: number[] }
  | { op: "read"; issueId: string }
  | { op: "read"; all: true };

export function fetchNotifications(fetchImpl?: FetchLike, opts: { includeRead?: boolean } = {}): Promise<Notification[]> {
  return apiFetch<Notification[]>(opts.includeRead ? "/notifications?includeRead=true" : "/notifications", {}, fetchImpl);
}

export function notificationRequest(action: NotificationAction): { path: string; body: Record<string, unknown> } {
  if (action.op !== "read") return { path: issuePath(action.issueId, action.op), body: {} };
  if ("ids" in action) return { path: "/notifications/read", body: { ids: action.ids } };
  if ("issueId" in action) return { path: "/notifications/read", body: { issueRef: action.issueId } };
  return { path: "/notifications/read", body: { all: true } };
}

export function postNotification(action: NotificationAction, fetchImpl?: FetchLike): Promise<SubscriptionState | { updated: number }> {
  const { path, body } = notificationRequest(action);
  return apiFetch(path, { method: "POST", body }, fetchImpl);
}
