import type { Database } from "bun:sqlite";
import { claimDesktopNotifications, finishDesktopNotification, getDesktopNotificationSettings, setDesktopNotificationSettings, findIssueRow, HUMAN_ACTOR, now, NodError, type DesktopPermission } from "@nod/core";
import type { Hono } from "hono";
import { invalid, readBody, reqString } from "../input";
export function registerDesktopNotificationRoutes(app: Hono, db: Database): void {
  const prefix = "/api/desktop-notifications";
  app.get(`${prefix}/settings`, c => c.json(getDesktopNotificationSettings(db)));
  app.post(`${prefix}/settings`, async c => {
    const body = await readBody(c, ["enabled"]);
    if (typeof body.enabled !== "boolean") throw invalid("enabled は真偽値で指定してください");
    return c.json(setDesktopNotificationSettings(db, body.enabled));
  });
  app.post(`${prefix}/claim`, async c => {
    const body = await readBody(c, ["permission"]);
    const permission = reqString(body, "permission");
    if (!["granted", "denied", "notDetermined"].includes(permission)) throw invalid("通知許可の状態が不正です");
    return c.json(claimDesktopNotifications(db, permission as DesktopPermission));
  });
  app.post(`${prefix}/result`, async c => {
    const body = await readBody(c, ["notificationId", "state"]);
    if (!Number.isSafeInteger(body.notificationId) || (body.notificationId as number) < 1) throw invalid("通知IDが不正です");
    if (body.state !== "sent" && body.state !== "failed") throw invalid("配信結果が不正です");
    finishDesktopNotification(db, body.notificationId as number, body.state);
    return c.json({ ok: true });
  });
  app.post(`${prefix}/opened`, async c => {
    const body = await readBody(c, ["issueId", "notificationId"]);
    const issue = findIssueRow(db, reqString(body, "issueId"));
    if (!Number.isSafeInteger(body.notificationId) || (body.notificationId as number) < 1) throw invalid("通知IDが不正です");
    // 通知だけ削除済みでもIssueを開ける。別IssueのIDや他の通知を既読にしない。
    const notification = db.query("SELECT issue_id FROM notifications WHERE id = ? AND recipient = ?").get(body.notificationId as number, HUMAN_ACTOR) as { issue_id: number } | null;
    if (notification && notification.issue_id !== issue.id) throw new NodError("INVALID_ARGS", "通知のIssueが一致しません");
    db.query("UPDATE notifications SET read_at = ? WHERE id = ? AND recipient = ? AND issue_id = ? AND read_at IS NULL AND deleted_at IS NULL").run(now(), body.notificationId as number, HUMAN_ACTOR, issue.id);
    return c.json({ ok: true });
  });
}
