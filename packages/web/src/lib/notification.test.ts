import { describe, expect, test } from "bun:test";
import type { Notification } from "../api/types";
import { describeNotification, groupNotifications } from "./notification";

const n = (over: Partial<Notification>): Notification => ({
  id: 1, kind: "issue_change", issueId: "API-1", issueTitle: "検索", workspace: "API", eventType: "comment_added",
  actor: "codex", data: {}, body: null, createdAt: "2026-09-29T10:00:00.000Z", readAt: null, ...over,
});

describe("describeNotification", () => {
  test("種別ごとに誰が何をどう変えたかを返す", () => {
    expect(describeNotification(n({ eventType: "status_changed", data: { from: "in_progress", to: "in_review" } }))).toBe("ステータスを In Progress → In Review に変更");
    expect(describeNotification(n({ eventType: "priority_changed", data: { from: 0, to: 2 } }))).toBe("優先度を No priority → High に変更");
    expect(describeNotification(n({ eventType: "assignee_changed", data: { from: null, to: "codex" } }))).toBe("担当を なし → codex に変更");
    expect(describeNotification(n({ eventType: "labels_changed", data: { added: ["bug"], removed: [] } }))).toBe("ラベルを変更（+bug）");
    expect(describeNotification(n({ eventType: "comment_added", body: "直した" }))).toBe("コメント: 直した");
    expect(describeNotification(n({ eventType: "review_rejected", data: { reason: "再度" } }))).toBe("差し戻し: 再度");
    expect(describeNotification(n({ eventType: "unknown_type" }))).toBe("unknown_type");
  });
});

describe("groupNotifications", () => {
  test("Issue ごとにまとめ、最新の通知が新しい Issue を上にし、未読数を数える", () => {
    const list = [
      n({ id: 3, issueId: "API-2", issueTitle: "画面", createdAt: "2026-09-29T12:00:00.000Z" }),
      n({ id: 2, createdAt: "2026-09-29T11:00:00.000Z", readAt: "2026-09-29T11:30:00.000Z" }),
      n({ id: 1, createdAt: "2026-09-29T10:00:00.000Z" }),
    ];
    const groups = groupNotifications(list);
    expect(groups.map((g) => [g.issueId, g.unread, g.notifications.map((x) => x.id)])).toEqual([
      ["API-2", 1, [3]],
      ["API-1", 1, [2, 1]],
    ]);
    expect(groups[1]?.latest.id).toBe(2);
  });
});
