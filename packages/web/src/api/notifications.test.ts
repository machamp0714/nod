import { describe, expect, test } from "bun:test";
import { notificationRequest } from "./notifications";

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
});
