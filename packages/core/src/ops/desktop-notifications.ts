import type { Database } from "bun:sqlite";
import { HUMAN_ACTOR, now } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { deliverDueReminders } from "./reminders";
import { deliverDueDateNotifications } from "./due-date-notifications";

export interface DesktopNotificationSettings { enabled: boolean; lastEnabledAt: string | null }
export interface DesktopNotification { notificationId: number; issueId: string; title: string; body: string; scheduledAt: string }
export type DesktopPermission = "granted" | "denied" | "notDetermined";
export interface DesktopNotificationOs { permission(): Promise<DesktopPermission>; send(item: DesktopNotification): Promise<void> }

export function getDesktopNotificationSettings(db: Database): DesktopNotificationSettings {
  const row = db.query("SELECT enabled, last_enabled_at FROM desktop_notification_settings WHERE id = 1").get() as { enabled: number; last_enabled_at: string | null };
  return { enabled: row.enabled === 1, lastEnabledAt: row.last_enabled_at };
}
export function setDesktopNotificationSettings(db: Database, enabled: boolean): DesktopNotificationSettings {
  return tx(db, () => {
    db.query(`UPDATE desktop_notification_settings SET last_enabled_at = CASE WHEN enabled = 0 AND ? = 1 THEN ? ELSE last_enabled_at END, enabled = ? WHERE id = 1`).run(+enabled, now(), +enabled);
    return getDesktopNotificationSettings(db);
  });
}
export function getDesktopNotificationDelivery(db: Database, notificationId: number): { state: string; reason: string | null } | null {
  return db.query("SELECT state, reason FROM desktop_notification_deliveries WHERE notification_id = ?").get(notificationId) as { state: string; reason: string | null } | null;
}

// ネイティブ側だけが呼ぶ配信契約。取得と対象条件の判定は同じ書き込みトランザクションで確定する。
export function claimDesktopNotifications(db: Database, permission: DesktopPermission, limit = 32): DesktopNotification[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new NodError("INVALID_ARGS", "取得件数は1〜100で指定してください");
  deliverDueReminders(db);
  deliverDueDateNotifications(db);
  return tx(db, () => {
    const settings = getDesktopNotificationSettings(db);
    if (!settings.enabled || settings.lastEnabledAt === null) return [];
    const ts = now();
    const rows = db.query(`SELECT n.id, n.kind, n.created_at, n.data, n.read_at, n.deleted_at, n.snoozed_until, i.archived_at, i.due_date, i.status,
      i.title, i.number, w.key AS ws_key
      FROM notifications n JOIN issues i ON i.id = n.issue_id JOIN workspaces w ON w.id = i.workspace_id
      LEFT JOIN desktop_notification_deliveries d ON d.notification_id = n.id
      WHERE n.recipient = ? AND n.kind IN ('reminder', 'due_date') AND d.notification_id IS NULL AND n.created_at <= ?
      ORDER BY n.created_at, n.id`).all(HUMAN_ACTOR, ts) as { id: number; kind: string; created_at: string; data: string; read_at: string | null; deleted_at: string | null; snoozed_until: string | null; archived_at: string | null; due_date: string | null; status: string; title: string; number: number; ws_key: string }[];
    const result: DesktopNotification[] = [];
    for (const row of rows) {
      // 既読・削除・再有効化前は保留中でも除外する。スヌーズ・アーカイブ中は許可判定を待つ。
      const held = row.archived_at || (row.snoozed_until && row.snoozed_until > ts);
      const data = JSON.parse(row.data) as { note?: string | null; dueDate?: string };
      // 個別リマインダーの旧分は保持するが、期日通知は現在の期日・未完了状態を配信直前にも確認する。
      const obsoleteDueDate = row.kind === "due_date" && (row.due_date !== data.dueDate || row.status === "done" || row.status === "canceled");
      const reason = row.created_at <= settings.lastEnabledAt ? "before_enabled" : row.read_at ? "read" : row.deleted_at ? "deleted" : obsoleteDueDate ? "due_date_inactive" : !held && permission !== "granted" ? "permission" : null;
      if (reason) {
        db.query("INSERT OR IGNORE INTO desktop_notification_deliveries (notification_id, state, reason, claimed_at, finished_at) VALUES (?, 'excluded', ?, ?, ?)").run(row.id, reason, ts, ts);
        continue;
      }
      if (held) continue;
      const changes = db.query("INSERT OR IGNORE INTO desktop_notification_deliveries (notification_id, state, claimed_at) VALUES (?, 'claimed', ?)").run(row.id, ts).changes;
      if (changes) {
        result.push({ notificationId: row.id, issueId: `${row.ws_key}-${row.number}`, title: row.title, body: row.kind === "due_date" ? `期日が到来しました（${data.dueDate}）` : data.note ?? "リマインダーの時刻です", scheduledAt: row.created_at });
      }
      if (result.length >= limit) break;
    }
    return result;
  });
}
export function finishDesktopNotification(db: Database, notificationId: number, state: "sent" | "failed"): void {
  db.query("UPDATE desktop_notification_deliveries SET state = ?, finished_at = ? WHERE notification_id = ? AND state = 'claimed'").run(state, now(), notificationId);
}

// 時計は共通のnow、OSだけを差し替えて実DBから送信結果まで検証する境界。
export async function deliverDesktopNotifications(db: Database, os: DesktopNotificationOs): Promise<void> {
  // 許可の取得エラーでは取得を確定せず、次の周期まで保留する。
  const permission = await os.permission();
  for (const item of claimDesktopNotifications(db, permission)) {
    try { await os.send(item); finishDesktopNotification(db, item.notificationId, "sent"); }
    catch { finishDesktopNotification(db, item.notificationId, "failed"); }
  }
}
