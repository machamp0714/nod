import { describe, expect, test } from "bun:test";
import { commentIssue, createIssue, getInbox } from "@nod/core";
import { call, setup } from "./helpers";

describe("購読と通知の API", () => {
  test("購読・解除は冪等で、Issue 詳細に購読状態が出る", async () => {
    const { app, me, ws } = setup();
    createIssue(me, { workspaceId: ws.id, title: "検索" });
    expect((await call(app, "GET", "/api/issues/API-1")).json.subscribed).toBe(false);
    for (let i = 0; i < 2; i++) {
      const r = await call(app, "POST", "/api/issues/API-1/subscribe");
      expect(r).toEqual({ status: 200, json: { issueId: "API-1", subscribed: true } });
    }
    expect((await call(app, "GET", "/api/issues/API-1")).json.subscribed).toBe(true);
    const off = await call(app, "POST", "/api/issues/API-1/unsubscribe");
    expect(off.json).toEqual({ issueId: "API-1", subscribed: false });
    expect((await call(app, "POST", "/api/issues/API-9/subscribe")).status).toBe(404);
    expect((await call(app, "POST", "/api/issues/API-1/subscribe", { x: 1 })).status).toBe(400);
  });

  test("通知の一覧・既読と、既存の /api/inbox の形は変わらない", async () => {
    const { app, db, me, llm, ws } = setup();
    createIssue(me, { workspaceId: ws.id, title: "検索" });
    createIssue(me, { workspaceId: ws.id, title: "画面" });
    await call(app, "POST", "/api/issues/API-1/subscribe");
    await call(app, "POST", "/api/issues/API-2/subscribe");
    commentIssue(llm, "API-1", "a1");
    commentIssue(llm, "API-2", "b1");
    // web（me）からのコメントは自分に通知しない
    await call(app, "POST", "/api/issues/API-1/comment", { body: "自分のメモ" });

    const list = await call(app, "GET", "/api/notifications");
    expect(list.status).toBe(200);
    expect(list.json.map((n: { body: string }) => n.body)).toEqual(["b1", "a1"]);
    expect(list.json[0]).toMatchObject({ issueId: "API-2", eventType: "comment_added", actor: "claude-code", readAt: null });

    const read = await call(app, "POST", "/api/notifications/read", { issueRef: "API-1" });
    expect(read).toEqual({ status: 200, json: { updated: 1 } });
    expect((await call(app, "GET", "/api/notifications")).json).toHaveLength(1);
    expect((await call(app, "GET", "/api/notifications?includeRead=true")).json).toHaveLength(2);
    expect((await call(app, "POST", "/api/notifications/read", { ids: [list.json[0].id] })).json).toEqual({ updated: 1 });
    expect((await call(app, "POST", "/api/notifications/read", { all: true })).json).toEqual({ updated: 0 });

    expect((await call(app, "POST", "/api/notifications/read", {})).status).toBe(400);
    expect((await call(app, "POST", "/api/notifications/read", { ids: ["1"] })).status).toBe(400);
    expect((await call(app, "POST", "/api/notifications/read", { ids: [999] })).status).toBe(404);
    expect((await call(app, "POST", "/api/notifications/read", { all: "yes" })).status).toBe(400);
    expect((await call(app, "GET", "/api/notifications?includeRead=x")).status).toBe(400);
    // 既読の上限（#98）
    expect((await call(app, "GET", "/api/notifications?includeRead=true&readLimit=1")).json).toHaveLength(1);
    for (const bad of ["0", "-1", "1.5", "x"]) {
      expect((await call(app, "GET", `/api/notifications?includeRead=true&readLimit=${bad}`)).status).toBe(400);
    }

    const inbox = await call(app, "GET", "/api/inbox");
    expect(Object.keys(inbox.json).sort()).toEqual(["questions", "reviews"]);
    expect(inbox.json).toEqual(JSON.parse(JSON.stringify(getInbox(db))));
  });

  test("通知のスヌーズと解除（#43）", async () => {
    const { app, me, llm, ws } = setup();
    createIssue(me, { workspaceId: ws.id, title: "検索" });
    await call(app, "POST", "/api/issues/API-1/subscribe");
    commentIssue(llm, "API-1", "a1");

    const until = "2999-01-01T00:00:00.000Z";
    const r = await call(app, "POST", "/api/notifications/snooze", { issueRef: "API-1", until });
    expect(r).toEqual({ status: 200, json: { updated: 1, snoozedUntil: until } });
    expect((await call(app, "GET", "/api/notifications?includeRead=true")).json).toEqual([]);
    const snoozed = await call(app, "GET", "/api/notifications?snoozed=true");
    expect(snoozed.json).toHaveLength(1);
    expect(snoozed.json[0]).toMatchObject({ issueId: "API-1", snoozedUntil: until });

    expect((await call(app, "POST", "/api/notifications/unsnooze", { ids: [snoozed.json[0].id] })).json).toEqual({ updated: 1 });
    expect((await call(app, "GET", "/api/notifications")).json[0]).toMatchObject({ snoozedUntil: null });

    expect((await call(app, "POST", "/api/notifications/snooze", { issueRef: "API-1" })).status).toBe(400);
    expect((await call(app, "POST", "/api/notifications/snooze", { issueRef: "API-1", until: "2000-01-01" })).status).toBe(400);
    expect((await call(app, "POST", "/api/notifications/snooze", { ids: [999], until })).status).toBe(404);
    expect((await call(app, "POST", "/api/notifications/unsnooze", {})).status).toBe(400);
    expect((await call(app, "GET", "/api/notifications?snoozed=x")).status).toBe(400);
  });

  test("通知の削除と取り消し（#44）", async () => {
    const { app, me, llm, ws } = setup();
    createIssue(me, { workspaceId: ws.id, title: "検索" });
    await call(app, "POST", "/api/issues/API-1/subscribe");
    commentIssue(llm, "API-1", "a1");

    const del = await call(app, "POST", "/api/notifications/delete", { issueRef: "API-1" });
    expect(del.status).toBe(200);
    expect(del.json.updated).toBe(1);
    expect((await call(app, "GET", "/api/notifications?includeRead=true")).json).toEqual([]);
    commentIssue(llm, "API-1", "a2");
    expect((await call(app, "GET", "/api/notifications")).json.map((n: { body: string }) => n.body)).toEqual(["a2"]);

    expect((await call(app, "POST", "/api/notifications/restore", { ids: del.json.ids })).json).toEqual({ updated: 1 });
    expect((await call(app, "GET", "/api/notifications")).json).toHaveLength(2);

    expect((await call(app, "POST", "/api/notifications/delete", {})).status).toBe(400);
    expect((await call(app, "POST", "/api/notifications/delete", { ids: [999] })).status).toBe(404);
    expect((await call(app, "POST", "/api/notifications/restore", {})).status).toBe(400);
    expect((await call(app, "POST", "/api/notifications/restore", { issueRef: "API-1" })).status).toBe(400);
  });
});
