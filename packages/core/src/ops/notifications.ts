import type { Database } from "bun:sqlite";
import { HUMAN_ACTOR, isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { findIssueRow, formatIssueId, type IssueRow } from "../issue-query";
import type { Notification, SubscriptionState } from "../types";
import { parseDateTime } from "./human";
import { deliverDueRemindersIfFree } from "./reminders";

export { NOTIFY_EVENT_TYPES } from "../notify";

function requireHuman(ctx: OpCtx, what = "Issue の購読を操作"): void {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", `LLM は${what}できません。me が行います`);
  }
}

function state(row: IssueRow, subscribed: boolean): SubscriptionState {
  return { issueId: formatIssueId(row.ws_key, row.number), subscribed };
}

export function isSubscribed(db: Database, ref: string, subscriber: string = HUMAN_ACTOR): boolean {
  return isSubscribedRow(db, findIssueRow(db, ref).id, subscriber);
}

export function isSubscribedRow(db: Database, issueId: number, subscriber: string = HUMAN_ACTOR): boolean {
  return db.query("SELECT 1 FROM subscriptions WHERE issue_id = ? AND subscriber = ?").get(issueId, subscriber) !== null;
}

// すでに購読中でもエラーにしない。購読は Issue への書き込みではなく自分の通知設定なので、アーカイブ済みでも変えられる
export function subscribeIssue(ctx: OpCtx, ref: string): SubscriptionState {
  requireHuman(ctx);
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    ctx.db
      .query("INSERT OR IGNORE INTO subscriptions (issue_id, subscriber, created_at) VALUES (?, ?, ?)")
      .run(row.id, ctx.actor, now());
    return state(row, true);
  });
}

// 購読していなくてもエラーにしない。届いた通知は残す。アーカイブ済みでも解除できる（subscribeIssue と同じ理由）
export function unsubscribeIssue(ctx: OpCtx, ref: string): SubscriptionState {
  requireHuman(ctx);
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    ctx.db.query("DELETE FROM subscriptions WHERE issue_id = ? AND subscriber = ?").run(row.id, ctx.actor);
    return state(row, false);
  });
}

interface NotificationRow {
  id: number;
  kind: string;
  event_type: string;
  actor: string;
  data: string;
  created_at: string;
  read_at: string | null;
  snoozed_until: string | null;
  issue_title: string;
  issue_number: number;
  ws_key: string;
  body: string | null;
}

// 既読を含む一覧（includeRead・snoozed）で出す既読の件数の既定。通知は消えずに増え続けるため、全履歴は返さない（#98）
export const NOTIFICATION_READ_LIMIT = 200;

// 新しい順。スヌーズ中（#43）と削除済み（#44）、アーカイブ済みの Issue（#30）の通知は出さない。既定では未読だけ。
// snoozed ならスヌーズ中のものだけを既読も含めて出す。
// 既読も出すときは、未読はすべて、既読は最近既読にしたものから readLimit 件だけを出す。
// 既読にした順で選ぶのは、開いて既読にした古い通知が一覧から消えないようにするため。
// 上限の数え方もアーカイブ済みの Issue を除く。除かないと、出さない既読が上限を消費する
// 読む前に、期限が来たリマインダー（#47）を通知に変える（読み取りでの書き込み。ロックが取れなければ次に回す）
export function listNotifications(
  db: Database,
  opts: { includeRead?: boolean; snoozed?: boolean; recipient?: string; readLimit?: number } = {},
): Notification[] {
  const readLimit = opts.readLimit ?? NOTIFICATION_READ_LIMIT;
  if (!Number.isSafeInteger(readLimit) || readLimit <= 0) {
    throw new NodError("INVALID_ARGS", "既読の通知の上限は正の整数で指定してください");
  }
  deliverDueRemindersIfFree(db);
  const ts = now();
  const recipient = opts.recipient ?? HUMAN_ACTOR;
  const visible = (t: string) => (opts.snoozed ? `${t}.snoozed_until > ?` : `(${t}.snoozed_until IS NULL OR ${t}.snoozed_until <= ?)`);
  const withRead = opts.snoozed || opts.includeRead;
  const where = withRead
    ? `${visible("n")} AND (n.read_at IS NULL OR n.id IN (
         SELECT m.id FROM notifications m JOIN issues mi ON mi.id = m.issue_id
         WHERE m.recipient = ? AND m.deleted_at IS NULL AND mi.archived_at IS NULL AND m.read_at IS NOT NULL AND ${visible("m")}
         ORDER BY m.read_at DESC, m.id DESC LIMIT ?))`
    : `${visible("n")} AND n.read_at IS NULL`;
  const params = withRead ? [recipient, ts, recipient, ts, readLimit] : [recipient, ts];
  const rows = db
    .query(
      `SELECT n.*, i.title AS issue_title, i.number AS issue_number, w.key AS ws_key, c.body AS body
       FROM notifications n JOIN issues i ON i.id = n.issue_id JOIN workspaces w ON w.id = i.workspace_id
       LEFT JOIN comments c ON c.id = n.comment_id
       WHERE n.recipient = ? AND n.deleted_at IS NULL AND i.archived_at IS NULL AND ${where}
       ORDER BY n.created_at DESC, n.id DESC`,
    )
    .all(...params) as NotificationRow[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    issueId: formatIssueId(r.ws_key, r.issue_number),
    issueTitle: r.issue_title,
    workspace: r.ws_key,
    eventType: r.event_type,
    actor: r.actor,
    data: JSON.parse(r.data) as Record<string, unknown>,
    body: r.body,
    createdAt: r.created_at,
    readAt: r.read_at,
    // 期限が過ぎたスヌーズは null にする
    snoozedUntil: r.snoozed_until !== null && r.snoozed_until > ts ? r.snoozed_until : null,
  }));
}

export interface MarkReadInput {
  ids?: number[];
  issueRef?: string;
  all?: boolean;
}

// ids・issueRef・all のどれか1つで既読にする。既読のものとスヌーズ中のものはそのまま。updated は今回既読にした件数
export function markNotificationsRead(ctx: OpCtx, input: MarkReadInput): { updated: number } {
  requireHuman(ctx, "通知を既読に");
  const given = [input.ids !== undefined, input.issueRef !== undefined, input.all === true].filter(Boolean).length;
  if (given !== 1) throw new NodError("INVALID_ARGS", "既読にする通知は ids・Issue・すべて のどれか1つで指定してください");
  if (input.ids !== undefined) {
    if (input.ids.length === 0) throw new NodError("INVALID_ARGS", "既読にする通知の id を指定してください");
    for (const id of input.ids) {
      if (!Number.isSafeInteger(id) || id <= 0) throw new NodError("INVALID_ARGS", "通知の id は正の整数で指定してください");
    }
  }
  return tx(ctx.db, () => {
    const ts = now();
    const base = `UPDATE notifications SET read_at = ? WHERE recipient = ? AND read_at IS NULL AND deleted_at IS NULL
      AND (snoozed_until IS NULL OR snoozed_until <= ?)`;
    if (input.ids !== undefined) {
      const exists = ctx.db.query("SELECT 1 FROM notifications WHERE id = ? AND recipient = ? AND deleted_at IS NULL");
      for (const id of input.ids) {
        if (exists.get(id, ctx.actor) === null) throw new NodError("NOT_FOUND", `通知 ${id} はありません`);
      }
      const stmt = ctx.db.query(`${base} AND id = ?`);
      return { updated: input.ids.reduce((sum, id) => sum + stmt.run(ts, ctx.actor, ts, id).changes, 0) };
    }
    if (input.issueRef !== undefined) {
      const row = findIssueRow(ctx.db, input.issueRef);
      return { updated: ctx.db.query(`${base} AND issue_id = ?`).run(ts, ctx.actor, ts, row.id).changes };
    }
    return { updated: ctx.db.query(base).run(ts, ctx.actor, ts).changes };
  });
}

// 通知を操作する対象。ids（nod notification list の #番号）か Issue のどちらか1つで指定する
export interface NotificationTarget {
  ids?: number[];
  issueRef?: string;
}

function validateIds(ids: number[] | undefined, verb: string): void {
  if (ids === undefined) return;
  if (ids.length === 0) throw new NodError("INVALID_ARGS", `${verb}通知の id を指定してください`);
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new NodError("INVALID_ARGS", "通知の id は正の整数で指定してください");
  }
}

// 対象の通知の id。削除済みは含めない。1件もなければ NOT_FOUND
function targetIds(ctx: OpCtx, target: NotificationTarget, verb: string): number[] {
  if ((target.ids !== undefined) === (target.issueRef !== undefined)) {
    throw new NodError("INVALID_ARGS", `${verb}通知は ids か Issue のどちらか1つで指定してください`);
  }
  validateIds(target.ids, verb);
  if (target.ids !== undefined) {
    const exists = ctx.db.query("SELECT 1 FROM notifications WHERE id = ? AND recipient = ? AND deleted_at IS NULL");
    for (const id of target.ids) {
      if (exists.get(id, ctx.actor) === null) throw new NodError("NOT_FOUND", `通知 ${id} はありません`);
    }
    return [...new Set(target.ids)];
  }
  const row = findIssueRow(ctx.db, target.issueRef!);
  const ids = (
    ctx.db
      .query("SELECT id FROM notifications WHERE issue_id = ? AND recipient = ? AND deleted_at IS NULL")
      .all(row.id, ctx.actor) as { id: number }[]
  ).map((r) => r.id);
  if (ids.length === 0) throw new NodError("NOT_FOUND", `${target.issueRef} の通知はありません`);
  return ids;
}

function inList(ids: number[]): string {
  return ids.map(() => "?").join(", ");
}

// 既読を未読に戻す（#161）。ids なら指定したもの、Issue なら一覧に出ている中で最新の1件だけを戻す
// （スヌーズの期限が来たときと同じ規則。古い履歴まで未読にして件数を膨らませない）。
// すでに未読のものとスヌーズ中のものはそのまま。updated は今回未読に戻した件数
export function markNotificationsUnread(ctx: OpCtx, input: NotificationTarget): { updated: number } {
  requireHuman(ctx, "通知を未読に");
  return tx(ctx.db, () => {
    const ids = targetIds(ctx, input, "未読に戻す");
    const ts = now();
    const shown = `deleted_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ?) AND id IN (${inList(ids)})`;
    const target = input.ids !== undefined ? "" : ` AND id = (SELECT MAX(id) FROM notifications WHERE ${shown})`;
    const params = input.ids !== undefined ? [ts, ...ids] : [ts, ...ids, ts, ...ids];
    return {
      updated: ctx.db.query(`UPDATE notifications SET read_at = NULL WHERE read_at IS NOT NULL AND ${shown}${target}`).run(...params).changes,
    };
  });
}

// until まで一覧から隠す（Triage の Issue の Snooze とは別）。期限が来たら、Issue ごとに最新の1件だけを未読として出し直す。
// そのため、スヌーズした時点で最新以外の未読は既読にする。
// 期限までに同じ Issue へ新しい通知が届いたら、そこで解く（releaseSnoozeOnArrival）
export function snoozeNotifications(ctx: OpCtx, input: NotificationTarget & { until: string }): { updated: number; snoozedUntil: string } {
  requireHuman(ctx, "通知をスヌーズ");
  const until = parseDateTime(input.until);
  const ts = now();
  if (until <= ts) throw new NodError("INVALID_ARGS", `${input.until} は過去の日時です。これから先の日時を指定してください`);
  return tx(ctx.db, () => {
    const ids = targetIds(ctx, input, "スヌーズする");
    const updated = ctx.db.query(`UPDATE notifications SET snoozed_until = ? WHERE id IN (${inList(ids)})`).run(until, ...ids).changes;
    const latest = `SELECT MAX(id) FROM notifications WHERE id IN (${inList(ids)}) GROUP BY issue_id`;
    ctx.db
      .query(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND id IN (${inList(ids)}) AND id NOT IN (${latest})`)
      .run(ts, ...ids, ...ids);
    ctx.db.query(`UPDATE notifications SET read_at = NULL WHERE id IN (${latest})`).run(...ids);
    return { updated, snoozedUntil: until };
  });
}

// スヌーズを解いてすぐ一覧に戻す。スヌーズ中でないものはそのまま。updated は今回解いた件数
export function unsnoozeNotifications(ctx: OpCtx, input: NotificationTarget): { updated: number } {
  requireHuman(ctx, "通知のスヌーズを解除");
  return tx(ctx.db, () => {
    const ids = targetIds(ctx, input, "スヌーズを解除する");
    return {
      updated: ctx.db
        .query(`UPDATE notifications SET snoozed_until = NULL WHERE snoozed_until > ? AND id IN (${inList(ids)})`)
        .run(now(), ...ids).changes,
    };
  });
}

// 一覧から消す（行は残す）。同じ Issue に後から届いた通知は、新しい通知として出る。
// ids は今回消した通知で、取り消し（restoreNotifications）に渡す
export function deleteNotifications(ctx: OpCtx, input: NotificationTarget): { updated: number; ids: number[] } {
  requireHuman(ctx, "通知を削除");
  return tx(ctx.db, () => {
    const ids = targetIds(ctx, input, "削除する");
    const updated = ctx.db.query(`UPDATE notifications SET deleted_at = ? WHERE id IN (${inList(ids)})`).run(now(), ...ids).changes;
    return { updated, ids };
  });
}

// 削除を取り消す。削除していないものはそのまま。updated は今回戻した件数。
// 削除のあとに（提案の置き換え・取り下げで）消えた通知は読み飛ばし、その件数を missing で返す（#134）
export function restoreNotifications(ctx: OpCtx, input: { ids: number[] }): { updated: number; missing: number } {
  requireHuman(ctx, "通知の削除を取り消し");
  validateIds(input.ids ?? [], "削除を取り消す");
  return tx(ctx.db, () => {
    const exists = ctx.db.query("SELECT 1 FROM notifications WHERE id = ? AND recipient = ?");
    const ids = [...new Set(input.ids)].filter((id) => exists.get(id, ctx.actor) !== null);
    const missing = new Set(input.ids).size - ids.length;
    if (ids.length === 0) return { updated: 0, missing };
    return {
      updated: ctx.db
        .query(`UPDATE notifications SET deleted_at = NULL WHERE deleted_at IS NOT NULL AND id IN (${inList(ids)})`)
        .run(...ids).changes,
      missing,
    };
  });
}
