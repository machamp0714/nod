import { describe, expect, test } from "bun:test";
import type { Notification } from "../api/types";
import { describeNotification, groupNotifications, groupSummary } from "./notification";

const n = (over: Partial<Notification>): Notification => ({
  id: 1, kind: "issue_change", issueId: "API-1", issueTitle: "検索", workspace: "API", eventType: "comment_added",
  actor: "codex", data: {}, body: null, createdAt: "2026-09-29T10:00:00.000Z", readAt: null, ...over,
});

describe("describeNotification", () => {
  test("誰が何をどう変えたかを1文で返し、short では本文を省く", () => {
    expect(describeNotification(n({ eventType: "status_changed", data: { from: "in_progress", to: "in_review" } }))).toBe("codex がステータスを In Review に変更しました");
    expect(describeNotification(n({ eventType: "priority_changed", data: { from: 0, to: 2 } }))).toBe("codex が優先度を High に変更しました");
    expect(describeNotification(n({ eventType: "assignee_changed", data: { from: null, to: "claude-code" } }))).toBe("codex が担当者を claude-code に変更しました");
    expect(describeNotification(n({ eventType: "assignee_changed", data: { from: "codex", to: null } }))).toBe("codex が担当者を外しました");
    expect(describeNotification(n({ eventType: "labels_changed", data: { added: ["bug"], removed: ["ui"] } }))).toBe("codex がラベルを変更しました（+bug -ui）");
    expect(describeNotification(n({ eventType: "comment_added", body: "直した" }))).toBe("codex がコメントしました：「直した」");
    expect(describeNotification(n({ eventType: "comment_added", body: "直した" }), { short: true })).toBe("codex がコメントしました");
    expect(describeNotification(n({ eventType: "review_rejected", data: { reason: "再度" } }))).toBe("codex が差し戻しました：「再度」");
    expect(describeNotification(n({ eventType: "unknown_type" }))).toBe("codex unknown_type");
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
    expect(groupSummary(groups[1]!)).toBe("codex がコメントしました ほか 1 件");
    expect(groupSummary(groups[0]!)).toBe("codex がコメントしました");
  });
});
