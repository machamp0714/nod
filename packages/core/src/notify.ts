import type { Database } from "bun:sqlite";
import { now } from "./ctx";

// 購読中の Issue で通知にする変化の種別。これ以外（作業状況・計画・確認依頼など）は通知しない。
// agent_state_changed と plan_updated は頻度が高く、LLM の完了・入力待ちの通知（#54）で別に扱う。
// question_asked は既存の Inbox の「確認依頼」で届くので、重ねて通知しない
export const NOTIFY_EVENT_TYPES = [
  "status_changed",
  "assignee_changed",
  "priority_changed",
  "title_changed",
  "project_changed",
  "labels_changed",
  "comment_added",
  "review_approved",
  "review_rejected",
  "triage_accepted",
  "triage_declined",
] as const;

export type NotifyEventType = (typeof NOTIFY_EVENT_TYPES)[number];

// 変化のもと。1つのもとから、購読者ごとに通知は1件だけ作る（UNIQUE で重ねて作らない）
export type NotifySource = { eventId: number } | { commentId: number };

export function isNotifyEventType(type: string): type is NotifyEventType {
  return (NOTIFY_EVENT_TYPES as readonly string[]).includes(type);
}

// 購読者に Issue の変化を通知する。操作した本人には通知しない
export function notifySubscribers(
  db: Database,
  issueId: number,
  actor: string,
  type: string,
  source: NotifySource,
  data: Record<string, unknown> = {},
): void {
  if (!isNotifyEventType(type)) return;
  const eventId = "eventId" in source ? source.eventId : null;
  const commentId = "commentId" in source ? source.commentId : null;
  db.query(
    `INSERT OR IGNORE INTO notifications (recipient, issue_id, kind, event_type, event_id, comment_id, actor, data, created_at)
     SELECT subscriber, issue_id, 'issue_change', ?, ?, ?, ?, ?, ? FROM subscriptions WHERE issue_id = ? AND subscriber <> ?`,
  ).run(type, eventId, commentId, actor, JSON.stringify(data), now(), issueId, actor);
}
