import type { Database } from "bun:sqlite";
import { HUMAN_ACTOR, isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { findIssueRow, findWritableIssueRow, formatIssueId } from "../issue-query";
import { releaseSnoozeOnArrival } from "../notify";
import type { IssueReminder, Reminder } from "../types";
import { parseDateTime } from "./human";

// Issue のリマインダー（#47）。常駐ジョブは持たず、通知一覧を読むとき（listNotifications）に期限が来たものを通知に変える。
// 1 Issue・1受け手に1件で、設定し直すと上書きする。設定・解除は人だけが行う。
// アーカイブ済みの Issue に届いた通知は、ほかの通知と同じく復元するまで一覧に出ない

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
    // 期限が来てまだ届けていないものを先に届ける。上書きで消すと、届くはずの通知が失われる
    deliverDueReminders(ctx.db);
    // アーカイブ済みの Issue には設定できない（#30）。解除は後片付けとして許す
    const row = findWritableIssueRow(ctx.db, ref);
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
    // 期限が来ていた分は解除せず通知として届ける（設定と同じ理由）
    deliverDueReminders(ctx.db);
    const row = findIssueRow(ctx.db, ref);
    const changes = ctx.db.query("DELETE FROM reminders WHERE issue_id = ? AND recipient = ?").run(row.id, ctx.actor).changes;
    return { issueId: formatIssueId(row.ws_key, row.number), cleared: changes > 0 };
  });
}

// まだ届いていないものだけ。期限の近い順。アーカイブ済みの Issue のものは出さない（届いても復元するまで一覧に出ないため）
export function listReminders(db: Database, recipient: string = HUMAN_ACTOR): Reminder[] {
  deliverDueRemindersIfFree(db);
  const rows = db
    .query(
      `SELECT r.remind_at, r.note, r.created_at, i.title, i.number, w.key AS ws_key
       FROM reminders r JOIN issues i ON i.id = r.issue_id JOIN workspaces w ON w.id = i.workspace_id
       WHERE r.recipient = ? AND i.archived_at IS NULL ORDER BY r.remind_at, r.issue_id`,
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
// DELETE ... RETURNING の1文で「消せた行＝届ける行」を決めるので、ほかの接続やプロセスと同時に呼んでも二重には作らない。
// 通知の挿入も同じトランザクションで行う。通知の時刻は期限の時刻にし、届いたらその Issue の通知のスヌーズを解く（ほかの新着と同じ）
export function deliverDueReminders(db: Database): number {
  const ts = now();
  // 読み取りだけで済む大半の呼び出しでは書き込みのロックを取らない
  if (db.query("SELECT 1 FROM reminders WHERE remind_at <= ? LIMIT 1").get(ts) === null) return 0;
  return tx(db, () => {
    const due = db
      .query("DELETE FROM reminders WHERE remind_at <= ? RETURNING issue_id, recipient, remind_at, note")
      .all(ts) as { issue_id: number; recipient: string; remind_at: string; note: string | null }[];
    const insert = db.query(
      `INSERT INTO notifications (recipient, issue_id, kind, event_type, actor, data, created_at)
       VALUES (?, ?, 'reminder', 'reminder', ?, ?, ?)`,
    );
    due.sort((a, b) => a.remind_at.localeCompare(b.remind_at) || a.issue_id - b.issue_id);
    for (const r of due) {
      insert.run(r.recipient, r.issue_id, r.recipient, JSON.stringify({ note: r.note }), r.remind_at);
      releaseSnoozeOnArrival(db, r.issue_id, ts, [r.recipient]);
    }
    return due.length;
  });
}

// 読み取りの操作（通知一覧・Issue 詳細・リマインダー一覧）から呼ぶ。ほかの処理が書き込み中で届けられなくても読み取りは続け、次に読んだときに届ける
export function deliverDueRemindersIfFree(db: Database): void {
  try {
    deliverDueReminders(db);
  } catch (e) {
    if (!(e instanceof NodError) || e.code !== "DB_BUSY") throw e;
  }
}
