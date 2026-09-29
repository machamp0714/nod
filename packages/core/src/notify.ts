import type { Database } from "bun:sqlite";
import { HUMAN_ACTOR, now } from "./ctx";

// 購読中の Issue で通知にする変化の種別。これ以外（作業状況・計画・確認依頼など）は通知しない。
// agent_state_changed と plan_updated は頻度が高いので購読の通知にしない。LLM の完了・入力待ち・エラーは notifyDelegator で届ける。
// question_asked は既存の Inbox の「確認依頼」で届くので、重ねて通知しない
export const NOTIFY_EVENT_TYPES = [
  "status_changed",
  "assignee_changed",
  "priority_changed",
  "estimate_changed",
  "due_date_changed",
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

// LLM に任せた Issue で、me が気づくべき作業の区切り。着手・再開（working）や外れ（null）は通知しない
const AGENT_NOTIFY_STATES = ["done", "awaiting_input", "error"];

// 担当が LLM の Issue で LLM の作業が完了・入力待ち・エラーになったら、購読していなくても me に届ける。
// 購読の通知とは kind で分け、同じイベントから重ねて作らない（UNIQUE (recipient, event_id)）
export function notifyDelegator(
  db: Database,
  issueId: number,
  actor: string,
  type: string,
  eventId: number,
  data: Record<string, unknown>,
): void {
  if (type !== "agent_state_changed" || actor === HUMAN_ACTOR) return;
  if (typeof data.to !== "string" || !AGENT_NOTIFY_STATES.includes(data.to)) return;
  if (typeof data.agent !== "string" || data.agent === HUMAN_ACTOR) return;
  db.query(
    `INSERT OR IGNORE INTO notifications (recipient, issue_id, kind, event_type, event_id, actor, data, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?, ?, ?)`,
  ).run(HUMAN_ACTOR, issueId, type, eventId, actor, JSON.stringify(data), now());
}

// LLM の完了・エラーの操作で同時に起きたコメントやステータスの変化は、LLM の通知を受け取った宛先では
// その1件にまとめる。LLM の通知を受け取らない購読者の通知は残す
export function collapseIntoAgentNotification(db: Database, issueId: number, sinceId: number): void {
  db.query(
    `DELETE FROM notifications WHERE id > ?1 AND issue_id = ?2 AND kind <> 'agent'
       AND recipient IN (SELECT recipient FROM notifications WHERE id > ?1 AND issue_id = ?2 AND kind = 'agent')`,
  ).run(sinceId, issueId);
}

// me が回答・承認・差し戻しで応じたら、その Issue の未読の LLM の通知は対応済みとして既読にする
export function readAgentNotifications(db: Database, issueId: number, recipient: string): void {
  db.query(
    "UPDATE notifications SET read_at = ? WHERE issue_id = ? AND recipient = ? AND kind = 'agent' AND read_at IS NULL",
  ).run(now(), issueId, recipient);
}

export function lastNotificationId(db: Database): number {
  return (db.query("SELECT COALESCE(MAX(id), 0) AS id FROM notifications").get() as { id: number }).id;
}

// 1つの判断の操作（承認・差し戻し・Triage の判断）は、その操作を表す1件（keepType）だけを通知に残す。
// 同じ操作で起きたステータスの変化やコメントは、Issue の Activity に残るので通知から外す
export function collapseNotifications(db: Database, issueId: number, sinceId: number, keepType: NotifyEventType): void {
  db.query("DELETE FROM notifications WHERE id > ? AND issue_id = ? AND event_type <> ?").run(sinceId, issueId, keepType);
}
