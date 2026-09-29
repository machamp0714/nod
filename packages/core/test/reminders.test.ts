import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { commentIssue, createIssue, getIssue } from "../src/ops/issues";
import { listNotifications, markNotificationsRead, snoozeNotifications, subscribeIssue } from "../src/ops/notifications";
import { clearReminder, deliverDueReminders, listReminders, setReminder } from "../src/ops/reminders";
import { codeOf, setup, tempDbPath } from "./helpers";

const FUTURE = "2999-01-01T09:00:00.000Z";

// 期限を過去にずらして、期限が来た状態を作る
function makeDue(db: ReturnType<typeof setup>["db"], at = "2000-01-01T00:00:00.000Z") {
  db.query("UPDATE reminders SET remind_at = ?").run(at);
}

describe("リマインダーの設定・変更・解除", () => {
  test("me は日時とメモで設定でき、Issue 詳細と一覧に出る", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    expect(getIssue(db, a.id).reminder).toBeNull();

    const r = setReminder(me, a.id, { at: "2999-01-01T18:00:00+09:00", note: "  レビュー結果を見る  " });
    expect(r).toMatchObject({ issueId: a.id, issueTitle: "検索", workspace: "API", remindAt: FUTURE, note: "レビュー結果を見る" });
    expect(getIssue(db, a.id).reminder).toEqual({ remindAt: FUTURE, note: "レビュー結果を見る" });
    expect(listReminders(db).map((x) => x.issueId)).toEqual([a.id]);
  });

  test("1 Issue に1件。設定し直すと上書きし、空のメモは null", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    setReminder(me, a.id, { at: FUTURE, note: "前" });
    setReminder(me, a.id, { at: "2999-02-01T00:00:00.000Z", note: "  " });
    expect(listReminders(db)).toHaveLength(1);
    expect(getIssue(db, a.id).reminder).toEqual({ remindAt: "2999-02-01T00:00:00.000Z", note: null });
  });

  test("解除は冪等で、解除したものは届かない", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    setReminder(me, a.id, { at: FUTURE });
    expect(clearReminder(me, a.id)).toEqual({ issueId: a.id, cleared: true });
    expect(clearReminder(me, a.id)).toEqual({ issueId: a.id, cleared: false });
    expect(getIssue(db, a.id).reminder).toBeNull();
    expect(listNotifications(db, { includeRead: true })).toEqual([]);
  });

  test("過去の日時・解釈できない日時・LLM・存在しない Issue は拒む", () => {
    const { ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    expect(codeOf(() => setReminder(me, a.id, { at: "2000-01-01T00:00:00Z" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => setReminder(me, a.id, { at: "あした" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => setReminder(llm, a.id, { at: FUTURE }))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => clearReminder(llm, a.id))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => setReminder(me, "API-999", { at: FUTURE }))).toBe("NOT_FOUND");
  });
});

describe("期限が来たリマインダーの通知", () => {
  test("期限前は通知にならず、期限が来たら通知一覧の取得時に kind=reminder の未読として出る", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    setReminder(me, a.id, { at: FUTURE, note: "見る" });
    expect(listNotifications(db)).toEqual([]);

    makeDue(db, "2001-02-03T04:05:06.000Z");
    const [n] = listNotifications(db);
    expect(n).toMatchObject({
      kind: "reminder",
      eventType: "reminder",
      issueId: a.id,
      actor: "me",
      data: { note: "見る" },
      createdAt: "2001-02-03T04:05:06.000Z",
      readAt: null,
      snoozedUntil: null,
    });
    // 届いたら設定は消える。二度は届かない
    expect(listReminders(db)).toEqual([]);
    expect(getIssue(db, a.id).reminder).toBeNull();
    expect(listNotifications(db)).toHaveLength(1);
  });

  test("購読していなくても届き、届いた後は通常の通知として既読にできる", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    setReminder(me, a.id, { at: FUTURE });
    makeDue(db);
    const [n] = listNotifications(db);
    expect(markNotificationsRead(me, { ids: [n!.id] })).toEqual({ updated: 1 });
    expect(listNotifications(db)).toEqual([]);
  });

  test("届いたらその Issue の通知のスヌーズを解く", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    subscribeIssue(me, a.id);
    commentIssue(llm, a.id, "進めます");
    snoozeNotifications(me, { issueRef: a.id, until: FUTURE });
    expect(listNotifications(db)).toEqual([]);

    setReminder(me, a.id, { at: FUTURE });
    makeDue(db);
    const list = listNotifications(db);
    expect(list.map((x) => x.kind).sort()).toEqual(["issue_change", "reminder"]);
    expect(listNotifications(db, { snoozed: true })).toEqual([]);
  });

  test("deliverDueReminders は期限前のものを残し、届けた件数を返す", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    const b = createIssue(me, { workspaceId: ws.id, title: "一覧" });
    setReminder(me, a.id, { at: FUTURE });
    setReminder(me, b.id, { at: FUTURE });
    db.query("UPDATE reminders SET remind_at = ? WHERE issue_id = (SELECT id FROM issues WHERE title = '検索')").run("2000-01-01T00:00:00.000Z");
    expect(deliverDueReminders(db)).toBe(1);
    expect(deliverDueReminders(db)).toBe(0);
    expect(listReminders(db).map((x) => x.issueId)).toEqual([b.id]);
  });

  test("別の接続から同時に読んでも通知は1件だけ作る", () => {
    const { db, ws, me } = setup();
    const path = db.filename;
    const other = openDb(path);
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    setReminder(me, a.id, { at: FUTURE });
    makeDue(db);
    expect(deliverDueReminders(db) + deliverDueReminders(other)).toBe(1);
    expect(listNotifications(other)).toHaveLength(1);
    expect(listNotifications(db)).toHaveLength(1);
    other.close();
  });

  test("Issue を消すとリマインダーも消える", () => {
    const db = openDb(tempDbPath());
    expect(db.query("SELECT sql FROM sqlite_master WHERE name = 'reminders'").get()).toMatchObject({
      sql: expect.stringContaining("ON DELETE CASCADE"),
    });
  });
});
