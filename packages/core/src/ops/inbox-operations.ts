import type { Database } from "bun:sqlite";
import { HUMAN_ACTOR, now, type OpCtx } from "../ctx";
import { tx } from "../db";

type InboxOperation = "subscribe" | "unsubscribe" | "read" | "unread" | "snooze" | "unsnooze" | "delete" | "restore" | "reminder_set" | "reminder_clear";

export interface InboxOperationRecord {
  id: number;
  operation: InboxOperation;
  actor: string;
  recipient: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  recordedAt: string;
}

// Inbox設定の変更と履歴を同時に確定する。解除・通知の物理削除でも操作記録は残す。
export function inboxOperation<T extends object>(
  ctx: OpCtx, operation: InboxOperation, input: object, apply: () => T,
): T {
  return tx(ctx.db, () => {
    const result = apply();
    ctx.db.query(`INSERT INTO inbox_operations (operation, actor, recipient, input, result, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(operation, ctx.actor, HUMAN_ACTOR, JSON.stringify(input), JSON.stringify(result), now());
    return result;
  });
}

export function listInboxOperations(db: Database): InboxOperationRecord[] {
  const rows = db.query("SELECT * FROM inbox_operations ORDER BY id DESC").all() as {
    id: number; operation: InboxOperation; actor: string; recipient: string;
    input: string; result: string; recorded_at: string;
  }[];
  return rows.map(row => ({
    id: row.id, operation: row.operation, actor: row.actor, recipient: row.recipient,
    input: JSON.parse(row.input), result: JSON.parse(row.result), recordedAt: row.recorded_at,
  }));
}
