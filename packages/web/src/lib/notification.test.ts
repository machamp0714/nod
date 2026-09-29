import { describe, expect, test } from "bun:test";
import type { Notification } from "../api/types";
import { customSnoozeUntil, describeNotification, formatSnoozeUntil, groupNotifications, groupSummary, nextSnoozeExpiry, snoozePresets, unreadToMark } from "./notification";

const n = (over: Partial<Notification>): Notification => ({
  id: 1, kind: "issue_change", issueId: "API-1", issueTitle: "検索", workspace: "API", eventType: "comment_added",
  actor: "codex", data: {}, body: null, createdAt: "2026-09-29T10:00:00.000Z", readAt: null, snoozedUntil: null, ...over,
});

describe("describeNotification", () => {
  test("誰が何をどう変えたかを1文で返し、short では本文を省く", () => {
    expect(describeNotification(n({ eventType: "status_changed", data: { from: "in_progress", to: "in_review" } }))).toBe("codex がステータスを In Review に変更しました");
    expect(describeNotification(n({ eventType: "priority_changed", data: { from: 0, to: 2 } }))).toBe("codex が優先度を High に変更しました");
    expect(describeNotification(n({ eventType: "estimate_changed", data: { from: null, to: 5 } }))).toBe("codex が見積もりを 5 pt に変更しました");
    expect(describeNotification(n({ eventType: "estimate_changed", data: { from: 5, to: null } }))).toBe("codex が見積もりを外しました");
    expect(describeNotification(n({ eventType: "due_date_changed", data: { from: null, to: "2026-10-15" } }))).toBe("codex が期限を 2026-10-15 に変更しました");
    expect(describeNotification(n({ eventType: "due_date_changed", data: { from: "2026-10-15", to: null } }))).toBe("codex が期限を外しました");
    expect(describeNotification(n({ eventType: "assignee_changed", data: { from: null, to: "claude-code" } }))).toBe("codex が担当者を claude-code に変更しました");
    expect(describeNotification(n({ eventType: "assignee_changed", data: { from: "codex", to: null } }))).toBe("codex が担当者を外しました");
    expect(describeNotification(n({ eventType: "labels_changed", data: { added: ["bug"], removed: ["ui"] } }))).toBe("codex がラベルを変更しました（+bug -ui）");
    expect(describeNotification(n({ eventType: "comment_added", body: "直した" }))).toBe("codex がコメントしました：「直した」");
    expect(describeNotification(n({ eventType: "comment_added", body: "直した" }), { short: true })).toBe("codex がコメントしました");
    expect(describeNotification(n({ eventType: "review_rejected", data: { reason: "再度" } }))).toBe("codex が差し戻しました：「再度」");
    expect(describeNotification(n({ eventType: "unknown_type" }))).toBe("codex unknown_type");
  });

  test("LLM の完了・入力待ち・エラーは Pencil の行の形で表し、short では質問・理由を省く（#54）", () => {
    const agent = (to: string, reason?: string) => n({ kind: "agent", eventType: "agent_state_changed", data: { from: "working", to, agent: "codex", ...(reason ? { reason } : {}) } });
    expect(describeNotification(agent("done"))).toBe("codex が作業を完了しました（レビュー待ち）");
    expect(describeNotification(agent("awaiting_input", "進めてよいか"))).toBe("codex が確認を求めました（入力待ち）：「進めてよいか」");
    expect(describeNotification(agent("awaiting_input", "進めてよいか"), { short: true })).toBe("codex が確認を求めました（入力待ち）");
    expect(describeNotification(agent("error", "DB に接続できない"))).toBe("codex がエラーで止まりました（エラー）：「DB に接続できない」");
    expect(describeNotification(agent("error", "DB に接続できない"), { short: true })).toBe("codex がエラーで止まりました（エラー）");
     // 操作したのが別の LLM でも、主語は担当（data.agent）
    const other = n({ kind: "agent", eventType: "agent_state_changed", actor: "codex", data: { from: "working", to: "error", agent: "claude-code", reason: "落ちた" } });
    expect(describeNotification(other)).toBe("claude-code がエラーで止まりました（エラー）：「落ちた」");
  });

  test("LLM の Triage 提案は判断の種類を添え、重複は元の Issue を示す。short では元を省く（#125）", () => {
    const proposal = (data: Record<string, unknown>) => n({ kind: "triage_proposal", eventType: "triage_proposed", actor: "claude-code", data });
    expect(describeNotification(proposal({ decision: "accept", duplicateOf: null }))).toBe("claude-code が Triage を提案しました（受け入れ）");
    expect(describeNotification(proposal({ decision: "decline", duplicateOf: null }))).toBe("claude-code が Triage を提案しました（却下）");
    expect(describeNotification(proposal({ decision: "duplicate", duplicateOf: "API-3" }))).toBe("claude-code が Triage を提案しました（重複、元: API-3）");
    expect(describeNotification(proposal({ decision: "duplicate", duplicateOf: "API-3" }), { short: true })).toBe("claude-code が Triage を提案しました（重複）");
  });

  test("リマインダーはメモを添え、メモ無しは時刻を知らせる。short でもメモは残す（#47）", () => {
    const reminder = (note: string | null) => n({ kind: "reminder", eventType: "reminder", actor: "me", data: { note } });
    expect(describeNotification(reminder("来週の定例で確認"))).toBe("リマインダー：来週の定例で確認");
    expect(describeNotification(reminder("来週の定例で確認"), { short: true })).toBe("リマインダー：来週の定例で確認");
    expect(describeNotification(reminder(null))).toBe("リマインダーの時刻です");
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

describe("unreadToMark", () => {
  const group = (items: Notification[]) => groupNotifications(items)[0]!;

  test("まだ既読にしていない未読のうち最新の id を返し、なければ null", () => {
    expect(unreadToMark(group([n({ id: 3 }), n({ id: 2, readAt: "x" })]), 0)).toBe(3);
    expect(unreadToMark(group([n({ id: 3, readAt: "x" })]), 0)).toBeNull();
  });

  test("既読にした後に同じ Issue へ新しい通知が届いたら、その id を返す", () => {
    expect(unreadToMark(group([n({ id: 3 })]), 3)).toBeNull();
    expect(unreadToMark(group([n({ id: 5, createdAt: "2026-09-29T11:00:00.000Z" }), n({ id: 3 })]), 3)).toBe(5);
  });
});

// 端末のタイムゾーンで計算する。テストもローカル時刻で組み立てる
describe("スヌーズのプリセットと期限の表示（#43）", () => {
  const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

  test("1時間後・明日 9:00・来週月曜 9:00 と、その具体的な時刻を返す", () => {
    const now = at(2026, 9, 30, 14, 20); // 水曜
    expect(snoozePresets(now).map((p) => [p.label, p.hint, p.until.getTime()])).toEqual([
      ["1時間後", "15:20", at(2026, 9, 30, 15, 20).getTime()],
      ["明日 9:00", "10月1日（木）", at(2026, 10, 1, 9).getTime()],
      ["来週月曜 9:00", "10月5日（月）", at(2026, 10, 5, 9).getTime()],
    ]);
  });

  test("月曜・日曜でも来週月曜は次の月曜", () => {
    expect(snoozePresets(at(2026, 10, 5, 8))[2]!.until).toEqual(at(2026, 10, 12, 9));
    expect(snoozePresets(at(2026, 10, 4, 22))[2]!.until).toEqual(at(2026, 10, 5, 9));
  });

  test("日時指定は日付と時刻の入力から作り、空や過去は null", () => {
    const now = at(2026, 9, 30, 14, 20);
    expect(customSnoozeUntil("2026-10-02", "14:00", now)).toEqual(at(2026, 10, 2, 14));
    expect(customSnoozeUntil("2026-10-02", "", now)).toEqual(at(2026, 10, 2, 9));
    expect(customSnoozeUntil("", "14:00", now)).toBeNull();
    expect(customSnoozeUntil("2026-09-30", "14:00", now)).toBeNull();
    expect(customSnoozeUntil("2026-02-31", "09:00", now)).toBeNull();
  });

  test("期限は今日・明日・それ以降で書き分ける", () => {
    const now = at(2026, 9, 30, 14, 20);
    expect(formatSnoozeUntil(at(2026, 9, 30, 15, 20).toISOString(), now)).toBe("今日 15:20 まで");
    expect(formatSnoozeUntil(at(2026, 10, 1, 9).toISOString(), now)).toBe("明日 9:00 まで");
    expect(formatSnoozeUntil(at(2026, 10, 2, 14).toISOString(), now)).toBe("10月2日 14:00 まで");
  });
});

describe("nextSnoozeExpiry", () => {
  const now = Date.parse("2026-09-29T10:00:00.000Z");
  test("いちばん早い期限までの時間に余裕を足して返し、スヌーズ中がなければ null", () => {
    expect(nextSnoozeExpiry([], now)).toBeNull();
    expect(nextSnoozeExpiry([n({ snoozedUntil: null })], now)).toBeNull();
    expect(nextSnoozeExpiry([
      n({ id: 1, snoozedUntil: "2026-09-29T11:00:00.000Z" }),
      n({ id: 2, snoozedUntil: "2026-09-29T10:00:30.000Z" }),
    ], now)).toBe(31_000);
  });

  test("過ぎた期限でも余裕の分は待ち、遠い先の期限は setTimeout の上限で打ち切る", () => {
    expect(nextSnoozeExpiry([n({ snoozedUntil: "2026-09-29T09:00:00.000Z" })], now)).toBe(1000);
    expect(nextSnoozeExpiry([n({ snoozedUntil: "2999-01-01T00:00:00.000Z" })], now)).toBe(2 ** 31 - 1);
  });
});

describe("ステータスの表示名", () => {
  test("通知の Issue の Workspace で設定した表示名で書く", () => {
    const item = n({ eventType: "status_changed", data: { from: "in_progress", to: "in_review" } });
    expect(describeNotification(item, { statusNames: { API: { in_review: "確認待ち" } } })).toBe("codex がステータスを 確認待ち に変更しました");
    expect(describeNotification(item, { statusNames: { NOD: { in_review: "確認待ち" } } })).toBe("codex がステータスを In Review に変更しました");
  });
});

