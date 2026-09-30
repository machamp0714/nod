import { describe, expect, test } from "bun:test";
import type { FetchLike } from "./client";
import { fetchNotifications, notificationRequest } from "./notifications";

describe("notificationRequest", () => {
  test("購読・解除は Issue の操作として空の本文を送る", () => {
    expect(notificationRequest({ op: "subscribe", issueId: "API-1" })).toEqual({ path: "/issues/API-1/subscribe", body: {} });
    expect(notificationRequest({ op: "unsubscribe", issueId: "API-1" })).toEqual({ path: "/issues/API-1/unsubscribe", body: {} });
  });

  test("既読は ids・Issue・すべて のどれか1つを送る", () => {
    expect(notificationRequest({ op: "read", ids: [3] })).toEqual({ path: "/notifications/read", body: { ids: [3] } });
    expect(notificationRequest({ op: "read", issueId: "API-1" }).body).toEqual({ issueRef: "API-1" });
    expect(notificationRequest({ op: "read", all: true }).body).toEqual({ all: true });
  });

  test("未読に戻すのは Issue を送る（#161）", () => {
    expect(notificationRequest({ op: "unread", issueId: "API-1" })).toEqual({ path: "/notifications/unread", body: { issueRef: "API-1" } });
  });

  test("スヌーズは ids か Issue と期限を、解除は ids か Issue を送る（#43）", () => {
    expect(notificationRequest({ op: "snooze", issueId: "API-1", until: "2026-10-01T00:00:00.000Z" })).toEqual({
      path: "/notifications/snooze",
      body: { issueRef: "API-1", until: "2026-10-01T00:00:00.000Z" },
    });
    expect(notificationRequest({ op: "unsnooze", issueId: "API-1" })).toEqual({ path: "/notifications/unsnooze", body: { issueRef: "API-1" } });
  });

  test("一覧は既読を含むか・スヌーズ中かをクエリで送る", async () => {
    const paths: string[] = [];
    const fake = (async (url: string) => {
      paths.push(String(url));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as FetchLike;
    await fetchNotifications(fake);
    await fetchNotifications(fake, { includeRead: true });
    await fetchNotifications(fake, { snoozed: true });
    expect(paths.map((p) => p.replace(/^.*\/api/, ""))).toEqual(["/notifications", "/notifications?includeRead=true", "/notifications?snoozed=true"]);
  });

  test("削除は Issue を、取り消しは削除の応答の ids を送る（#44）", () => {
    expect(notificationRequest({ op: "delete", issueId: "API-1" })).toEqual({ path: "/notifications/delete", body: { issueRef: "API-1" } });
    expect(notificationRequest({ op: "restore", ids: [3, 4] })).toEqual({ path: "/notifications/restore", body: { ids: [3, 4] } });
  });
});
