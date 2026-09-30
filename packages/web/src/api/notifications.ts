import { apiFetch, type FetchLike } from "./client";
import { issuePath } from "./query-keys";
import type { Notification, Reminder, SubscriptionState } from "./types";

// 購読（#45）と通知（#42）の API
export type NotificationAction =
  | { op: "subscribe"; issueId: string }
  | { op: "unsubscribe"; issueId: string }
  | { op: "read"; ids: number[] }
  | { op: "read"; issueId: string }
  | { op: "read"; all: true }
  | { op: "unread"; issueId: string }
  | { op: "snooze"; issueId: string; until: string }
  | { op: "unsnooze"; issueId: string }
  | { op: "delete"; issueId: string }
  | { op: "restore"; ids: number[] };

// snoozed はスヌーズ中のものだけ（#43）
export function fetchNotifications(fetchImpl?: FetchLike, opts: { includeRead?: boolean; snoozed?: boolean } = {}): Promise<Notification[]> {
  const query = opts.snoozed ? "?snoozed=true" : opts.includeRead ? "?includeRead=true" : "";
  return apiFetch<Notification[]>(`/notifications${query}`, {}, fetchImpl);
}

// まだ届いていないリマインダー（#47）
export function fetchReminders(fetchImpl?: FetchLike): Promise<Reminder[]> {
  return apiFetch<Reminder[]>("/reminders", {}, fetchImpl);
}

export function notificationRequest(action: NotificationAction): { path: string; body: Record<string, unknown> } {
  // Issue の最新の1件を未読に戻す（#161）
  if (action.op === "unread") return { path: "/notifications/unread", body: { issueRef: action.issueId } };
  if (action.op === "snooze") return { path: "/notifications/snooze", body: { issueRef: action.issueId, until: action.until } };
  if (action.op === "unsnooze") return { path: "/notifications/unsnooze", body: { issueRef: action.issueId } };
  if (action.op === "delete") return { path: "/notifications/delete", body: { issueRef: action.issueId } };
  if (action.op === "restore") return { path: "/notifications/restore", body: { ids: action.ids } };
  if (action.op !== "read") return { path: issuePath(action.issueId, action.op), body: {} };
  if ("ids" in action) return { path: "/notifications/read", body: { ids: action.ids } };
  if ("issueId" in action) return { path: "/notifications/read", body: { issueRef: action.issueId } };
  return { path: "/notifications/read", body: { all: true } };
}

export function postNotification(action: NotificationAction, fetchImpl?: FetchLike): Promise<SubscriptionState | { updated: number; snoozedUntil?: string; ids?: number[]; missing?: number }> {
  const { path, body } = notificationRequest(action);
  return apiFetch(path, { method: "POST", body }, fetchImpl);
}
