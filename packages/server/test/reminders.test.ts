import { describe, expect, test } from "bun:test";
import { createIssue } from "@nod/core";
import { call, setup } from "./helpers";

describe("リマインダーの API（#47）", () => {
  test("設定・上書き・解除ができ、Issue 詳細と /api/reminders に出る", async () => {
    const { app, me, ws } = setup();
    createIssue(me, { workspaceId: ws.id, title: "検索" });
    const set = await call(app, "POST", "/api/issues/API-1/remind", { at: "2999-01-01T09:00:00.000Z", note: "見る" });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ issueId: "API-1", remindAt: "2999-01-01T09:00:00.000Z", note: "見る" });
    expect((await call(app, "GET", "/api/issues/API-1")).json.reminder).toEqual({ remindAt: "2999-01-01T09:00:00.000Z", note: "見る" });

    await call(app, "POST", "/api/issues/API-1/remind", { at: "2999-02-01T00:00:00.000Z" });
    const list = await call(app, "GET", "/api/reminders");
    expect(list.json).toHaveLength(1);
    expect(list.json[0]).toMatchObject({ issueId: "API-1", remindAt: "2999-02-01T00:00:00.000Z", note: null });

    expect((await call(app, "POST", "/api/issues/API-1/unremind")).json).toEqual({ issueId: "API-1", cleared: true });
    expect((await call(app, "GET", "/api/issues/API-1")).json.reminder).toBeNull();
    expect((await call(app, "GET", "/api/reminders")).json).toEqual([]);
  });

  test("過去・不正な日時は 400、存在しない Issue は 404、知らないキーは 400", async () => {
    const { app, me, ws } = setup();
    createIssue(me, { workspaceId: ws.id, title: "検索" });
    expect((await call(app, "POST", "/api/issues/API-1/remind", { at: "2000-01-01" })).status).toBe(400);
    expect((await call(app, "POST", "/api/issues/API-1/remind", { at: "あした" })).status).toBe(400);
    expect((await call(app, "POST", "/api/issues/API-1/remind", {})).status).toBe(400);
    expect((await call(app, "POST", "/api/issues/API-1/remind", { at: "2999-01-01", x: 1 })).status).toBe(400);
    expect((await call(app, "POST", "/api/issues/API-9/remind", { at: "2999-01-01" })).status).toBe(404);
  });

  test("期限が来たら /api/notifications で kind=reminder の通知として出る", async () => {
    const { app, db, me, ws } = setup();
    createIssue(me, { workspaceId: ws.id, title: "検索" });
    await call(app, "POST", "/api/issues/API-1/remind", { at: "2999-01-01", note: "見る" });
    expect((await call(app, "GET", "/api/notifications")).json).toEqual([]);
    db.query("UPDATE reminders SET remind_at = '2000-01-01T00:00:00.000Z'").run();
    const list = await call(app, "GET", "/api/notifications");
    expect(list.json).toHaveLength(1);
    expect(list.json[0]).toMatchObject({ kind: "reminder", issueId: "API-1", data: { note: "見る" }, readAt: null });
  });
});
