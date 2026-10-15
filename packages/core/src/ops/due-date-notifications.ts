import type { Database } from "bun:sqlite";
import { HUMAN_ACTOR, now } from "../ctx";
import { tx } from "../db";
import { dueDateAtNine } from "../due-date-time";
import { NodError } from "../errors";

// 起票と実際の期日変更だけが呼ぶ。同じ期日の処理履歴は日付を往復しても保持する。
export function recordDueDateSetting(db: Database, issueId: number, dueDate: string | null, setAt: string): void {
  if (dueDate === null) return;
  db.query(`INSERT INTO due_date_occurrences (issue_id, due_date, set_at, state) VALUES (?, ?, ?, 'pending')
    ON CONFLICT (issue_id, due_date) DO UPDATE SET set_at = excluded.set_at WHERE due_date_occurrences.state = 'pending'`).run(issueId, dueDate, setAt);
}

// 生成済みの旧期日は変更と同じトランザクションで除外し、元の日付・未完了に戻しても復活させない。
// 取得済みの通知と、まだInbox化していない発生は変更しない。
export function excludeUnclaimedDueDateNotifications(db: Database, issueId: number, ts: string): void {
  db.query(`INSERT OR IGNORE INTO desktop_notification_deliveries (notification_id, state, reason, claimed_at, finished_at)
    SELECT id, 'excluded', 'due_date_inactive', ?, ? FROM notifications WHERE issue_id = ? AND kind = 'due_date'`).run(ts, ts, issueId);
}

export function deliverDueDateNotifications(db: Database): number {
  return tx(db, () => {
    const ts = now();
    const rows = db.query(`SELECT o.issue_id, o.due_date, o.set_at, i.status FROM due_date_occurrences o
      JOIN issues i ON i.id = o.issue_id AND i.due_date = o.due_date WHERE o.state = 'pending'`).all() as { issue_id: number; due_date: string; set_at: string | null; status: string }[];
    let delivered = 0;
    for (const row of rows) {
      const atNine = dueDateAtNine(row.due_date);
      const scheduledAt = row.set_at && row.set_at > atNine ? row.set_at : atNine;
      if (scheduledAt > ts) continue;
      if (row.status === "done" || row.status === "canceled") {
        db.query("UPDATE due_date_occurrences SET state = 'excluded' WHERE issue_id = ? AND due_date = ?").run(row.issue_id, row.due_date);
        continue;
      }
      const { lastInsertRowid } = db.query(`INSERT INTO notifications (recipient, issue_id, kind, event_type, actor, data, created_at)
        VALUES (?, ?, 'due_date', 'due_date_arrived', ?, ?, ?)`).run(HUMAN_ACTOR, row.issue_id, HUMAN_ACTOR, JSON.stringify({ dueDate: row.due_date }), scheduledAt);
      db.query("UPDATE due_date_occurrences SET state = 'notified', notification_id = ? WHERE issue_id = ? AND due_date = ?").run(lastInsertRowid, row.issue_id, row.due_date);
      delivered++;
    }
    return delivered;
  });
}

export function deliverDueDateNotificationsIfFree(db: Database): void {
  try { deliverDueDateNotifications(db); }
  catch (error) { if (!(error instanceof NodError) || error.code !== "DB_BUSY") throw error; }
}
