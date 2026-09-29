import type { Database } from "bun:sqlite";
import {
  deleteNotifications,
  listNotifications,
  listReminders,
  markNotificationsRead,
  type OpCtx,
  restoreNotifications,
  snoozeNotifications,
  unsnoozeNotifications,
} from "@nod/core";
import type { Hono } from "hono";
import { type Body, invalid, optString, queryFlag, readBody, reqString } from "../input";

function optIds(body: Body): number[] | undefined {
  const v = body.ids;
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "number" || !Number.isInteger(x))) {
    throw invalid("ids は整数の配列で指定してください");
  }
  return v as number[];
}

function optTrue(body: Body, key: string): true | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v !== true) throw invalid(`${key} は true で指定してください`);
  return true;
}

// 既読も出す一覧で返す既読の件数（#98）。省略すれば core の既定（NOTIFICATION_READ_LIMIT）
function queryReadLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw invalid(`readLimit は正の整数で指定してください（受け取った値: ${value}）`);
  return Number(value);
}

// Inbox の通知（購読中の Issue の変化）。受け手は me
export function registerNotificationRoutes(app: Hono, db: Database, me: OpCtx): void {
  app.get("/api/notifications", (c) =>
    c.json(
      listNotifications(db, {
        includeRead: queryFlag(c.req.query("includeRead"), "includeRead"),
        snoozed: queryFlag(c.req.query("snoozed"), "snoozed"),
        readLimit: queryReadLimit(c.req.query("readLimit")),
      }),
    ),
  );
  // まだ届いていないリマインダー（#47）。Web は次の期限に通知を読み直すために使う
  app.get("/api/reminders", (c) => c.json(listReminders(db)));
  app.post("/api/notifications/read", async (c) => {
    const body = await readBody(c, ["ids", "issueRef", "all"]);
    return c.json(markNotificationsRead(me, { ids: optIds(body), issueRef: optString(body, "issueRef"), all: optTrue(body, "all") }));
  });
  // 通知のスヌーズ（#43）。Triage の Issue の Snooze（/api/issues/:id/snooze）とは別
  app.post("/api/notifications/snooze", async (c) => {
    const body = await readBody(c, ["ids", "issueRef", "until"]);
    return c.json(snoozeNotifications(me, { ids: optIds(body), issueRef: optString(body, "issueRef"), until: reqString(body, "until") }));
  });
  app.post("/api/notifications/unsnooze", async (c) => {
    const body = await readBody(c, ["ids", "issueRef"]);
    return c.json(unsnoozeNotifications(me, { ids: optIds(body), issueRef: optString(body, "issueRef") }));
  });
  // 通知の削除（#44）と、その取り消し（ids は削除の応答の ids）
  app.post("/api/notifications/delete", async (c) => {
    const body = await readBody(c, ["ids", "issueRef"]);
    return c.json(deleteNotifications(me, { ids: optIds(body), issueRef: optString(body, "issueRef") }));
  });
  app.post("/api/notifications/restore", async (c) => {
    const body = await readBody(c, ["ids"]);
    const ids = optIds(body);
    if (ids === undefined) throw invalid("ids を指定してください");
    return c.json(restoreNotifications(me, { ids }));
  });
}
