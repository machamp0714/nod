import type { Database } from "bun:sqlite";
import { HUMAN_ACTOR, isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { findIssueRow, formatIssueId, type IssueRow } from "../issue-query";
import type { Notification, SubscriptionState } from "../types";

export { NOTIFY_EVENT_TYPES } from "../notify";

function requireHuman(ctx: OpCtx): void {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は Issue の購読を操作できません。購読は me が行います");
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

// すでに購読中でもエラーにしない
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

// 購読していなくてもエラーにしない。届いた通知は残す
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
  issue_title: string;
  issue_number: number;
  ws_key: string;
  body: string | null;
}

// 新しい順。スヌーズ中（#43）と削除済み（#44）は出さない。既定では未読だけ
export function listNotifications(
  db: Database,
  opts: { includeRead?: boolean; recipient?: string } = {},
): Notification[] {
  const rows = db
    .query(
      `SELECT n.*, i.title AS issue_title, i.number AS issue_number, w.key AS ws_key, c.body AS body
       FROM notifications n JOIN issues i ON i.id = n.issue_id JOIN workspaces w ON w.id = i.workspace_id
       LEFT JOIN comments c ON c.id = n.comment_id
       WHERE n.recipient = ? AND n.deleted_at IS NULL AND (n.snoozed_until IS NULL OR n.snoozed_until <= ?)
       ${opts.includeRead ? "" : "AND n.read_at IS NULL"}
       ORDER BY n.created_at DESC, n.id DESC`,
    )
    .all(opts.recipient ?? HUMAN_ACTOR, now()) as NotificationRow[];
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
  }));
}

export interface MarkReadInput {
  ids?: number[];
  issueRef?: string;
  all?: boolean;
}

// ids・issueRef・all のどれか1つで既読にする。既読のものはそのまま。updated は今回既読にした件数
export function markNotificationsRead(ctx: OpCtx, input: MarkReadInput): { updated: number } {
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
    const base = "UPDATE notifications SET read_at = ? WHERE recipient = ? AND read_at IS NULL AND deleted_at IS NULL";
    if (input.ids !== undefined) {
      const exists = ctx.db.query("SELECT 1 FROM notifications WHERE id = ? AND recipient = ? AND deleted_at IS NULL");
      for (const id of input.ids) {
        if (exists.get(id, ctx.actor) === null) throw new NodError("NOT_FOUND", `通知 ${id} はありません`);
      }
      const stmt = ctx.db.query(`${base} AND id = ?`);
      return { updated: input.ids.reduce((sum, id) => sum + stmt.run(ts, ctx.actor, id).changes, 0) };
    }
    if (input.issueRef !== undefined) {
      const row = findIssueRow(ctx.db, input.issueRef);
      return { updated: ctx.db.query(`${base} AND issue_id = ?`).run(ts, ctx.actor, row.id).changes };
    }
    return { updated: ctx.db.query(base).run(ts, ctx.actor).changes };
  });
}
