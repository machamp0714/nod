import type { Database } from "bun:sqlite";
import { HUMAN_ACTOR, isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { findIssueRow, formatIssueId } from "../issue-query";
import { releaseSnoozeOnArrival } from "../notify";
import type { IssueReminder, Reminder } from "../types";
import { parseDateTime } from "./human";

// Issue のリマインダー（#47）。常駐ジョブは持たず、通知一覧を読むとき（listNotifications）に期限が来たものを通知に変える。
// 1 Issue・1受け手に1件で、設定し直すと上書きする。設定・解除は人だけが行う

function requireHuman(ctx: OpCtx, what: string): void {
  if (isLlm(ctx)) throw new NodError("FORBIDDEN_FOR_LLM", `LLM はリマインダーを${what}できません。me が行います`);
}

export interface SetReminderInput {
  at: string; // 日時。日付だけならローカルの 0 時（スヌーズと同じ解釈）
  note?: string | null; // 空白だけなら null
}

export function setReminder(ctx: OpCtx, ref: string, input: SetReminderInput): Reminder {
  requireHuman(ctx, "設定");
  const at = parseDateTime(input.at);
  if (at <= now()) throw new NodError("INVALID_ARGS", `${input.at} は過去の日時です。これから先の日時を指定してください`);
  const note = input.note?.trim() || null;
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    const ts = now();
    ctx.db
      .query(
        `INSERT INTO reminders (issue_id, recipient, remind_at, note, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (issue_id, recipient) DO UPDATE SET remind_at = excluded.remind_at, note = excluded.note, created_at = excluded.created_at`,
      )
      .run(row.id, ctx.actor, at, note, ts);
    return {
      issueId: formatIssueId(row.ws_key, row.number),
      issueTitle: row.title,
      workspace: row.ws_key,
      remindAt: at,
      note,
      createdAt: ts,
    };
  });
}

// 設定していなくてもエラーにしない。cleared は今回消したか
export function clearReminder(ctx: OpCtx, ref: string): { issueId: string; cleared: boolean } {
  requireHuman(ctx, "解除");
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    const changes = ctx.db.query("DELETE FROM reminders WHERE issue_id = ? AND recipient = ?").run(row.id, ctx.actor).changes;
    return { issueId: formatIssueId(row.ws_key, row.number), cleared: changes > 0 };
  });
}

// まだ届いていないものだけ。期限の近い順
export function listReminders(db: Database, recipient: string = HUMAN_ACTOR): Reminder[] {
  deliverDueReminders(db);
  const rows = db
    .query(
      `SELECT r.remind_at, r.note, r.created_at, i.title, i.number, w.key AS ws_key
       FROM reminders r JOIN issues i ON i.id = r.issue_id JOIN workspaces w ON w.id = i.workspace_id
       WHERE r.recipient = ? ORDER BY r.remind_at, r.issue_id`,
    )
    .all(recipient) as { remind_at: string; note: string | null; created_at: string; title: string; number: number; ws_key: string }[];
  return rows.map((r) => ({
    issueId: formatIssueId(r.ws_key, r.number),
    issueTitle: r.title,
    workspace: r.ws_key,
    remindAt: r.remind_at,
    note: r.note,
    createdAt: r.created_at,
  }));
}

// Issue 詳細に出す、まだ期限の来ていないリマインダー
export function loadReminder(db: Database, issueId: number, recipient: string = HUMAN_ACTOR): IssueReminder | null {
  const row = db
    .query("SELECT remind_at, note FROM reminders WHERE issue_id = ? AND recipient = ? AND remind_at > ?")
    .get(issueId, recipient, now()) as { remind_at: string; note: string | null } | null;
  return row ? { remindAt: row.remind_at, note: row.note } : null;
}

// 期限が来たリマインダーを kind='reminder' の未読の通知に変える。読み取りの操作から呼ぶ副作用で、届けた件数を返す。
// 行の削除と通知の挿入を1つのトランザクションで行い、削除できた行だけ通知にするので、同時に読んでも二重には作らない。
// 通知の時刻は期限の時刻にし、届いたらその Issue の通知のスヌーズを解く（ほかの新着と同じ）
export function deliverDueReminders(db: Database): number {
  const ts = now();
  // 読み取りだけで済む大半の呼び出しでは書き込みのロックを取らない
  if (db.query("SELECT 1 FROM reminders WHERE remind_at <= ? LIMIT 1").get(ts) === null) return 0;
  return tx(db, () => {
    const due = db
      .query("SELECT issue_id, recipient, remind_at, note FROM reminders WHERE remind_at <= ? ORDER BY remind_at")
      .all(ts) as { issue_id: number; recipient: string; remind_at: string; note: string | null }[];
    const remove = db.query("DELETE FROM reminders WHERE issue_id = ? AND recipient = ? AND remind_at = ?");
    const insert = db.query(
      `INSERT INTO notifications (recipient, issue_id, kind, event_type, actor, data, created_at)
       VALUES (?, ?, 'reminder', 'reminder', ?, ?, ?)`,
    );
    let delivered = 0;
    for (const r of due) {
      if (remove.run(r.issue_id, r.recipient, r.remind_at).changes === 0) continue;
      insert.run(r.recipient, r.issue_id, r.recipient, JSON.stringify({ note: r.note }), r.remind_at);
      releaseSnoozeOnArrival(db, r.issue_id, ts, [r.recipient]);
      delivered++;
    }
    return delivered;
  });
}
