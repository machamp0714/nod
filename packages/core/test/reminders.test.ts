import { describe, expect, setSystemTime, test } from "bun:test";
import { openDb } from "../src/db";
import { archiveIssue, commentIssue, createIssue, getIssue } from "../src/ops/issues";
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

test("アーカイブ済みの Issue には設定できず、解除はできる（#30）", () => {
  const { db, ws, me } = setup();
  const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
  setReminder(me, a.id, { at: FUTURE });
  archiveIssue(me, a.id);
  expect(codeOf(() => setReminder(me, a.id, { at: FUTURE }))).toBe("ISSUE_ARCHIVED");
  expect(clearReminder(me, a.id)).toEqual({ issueId: a.id, cleared: true });
  expect(listReminders(db)).toEqual([]);
});

test("アーカイブ済みの Issue のリマインダーは一覧に出さず、Issue 詳細には出す（解除のため）", () => {
  const { db, ws, me } = setup();
  const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
  const b = createIssue(me, { workspaceId: ws.id, title: "一覧" });
  setReminder(me, a.id, { at: FUTURE });
  setReminder(me, b.id, { at: FUTURE });
  archiveIssue(me, a.id);
  expect(listReminders(db).map((x) => x.issueId)).toEqual([b.id]);
  expect(getIssue(db, a.id).reminder).toEqual({ remindAt: FUTURE, note: null });
});

describe("期限が来たのにまだ届けていないリマインダーを失わない", () => {
  test("設定し直しても、期限が来ていた分は通知として1件届き、新しい設定が残る", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    setReminder(me, a.id, { at: FUTURE, note: "前" });
    makeDue(db);
    setReminder(me, a.id, { at: "2999-02-01T00:00:00.000Z", note: "後" });
    expect(deliverDueReminders(db)).toBe(0);
    expect(getIssue(db, a.id).reminder).toEqual({ remindAt: "2999-02-01T00:00:00.000Z", note: "後" });
    const list = listNotifications(db);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "reminder", data: { note: "前" } });
  });

  test("解除しても、期限が来ていた分は通知として1件届く（解除するものは残っていない）", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    setReminder(me, a.id, { at: FUTURE, note: "見る" });
    makeDue(db);
    expect(clearReminder(me, a.id)).toEqual({ issueId: a.id, cleared: false });
    expect(deliverDueReminders(db)).toBe(0);
    expect(listNotifications(db).map((n) => n.kind)).toEqual(["reminder"]);
  });

  test("Issue 詳細を開くと期限が来た分を届けてから返す", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    setReminder(me, a.id, { at: FUTURE });
    makeDue(db);
    expect(getIssue(db, a.id).reminder).toBeNull();
    expect(deliverDueReminders(db)).toBe(0);
    expect(listNotifications(db)).toHaveLength(1);
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

  test("期限ちょうど（remind_at == now）で届き、1ms 前には届かない", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    setReminder(me, a.id, { at: FUTURE });
    const at = "2030-05-06T07:08:09.010Z";
    makeDue(db, at);
    try {
      setSystemTime(new Date(Date.parse(at) - 1));
      expect(deliverDueReminders(db)).toBe(0);
      setSystemTime(new Date(at));
      expect(deliverDueReminders(db)).toBe(1);
    } finally {
      setSystemTime();
    }
    expect(listNotifications(db).map((n) => n.createdAt)).toEqual([at]);
  });

  test("同じ DB の2つの接続から交互に届けても、1件のリマインダーは1件の通知になる", () => {
    const { db, ws, me } = setup();
    const other = openDb(db.filename);
    const ids = ["検索", "一覧", "設定"].map((title) => createIssue(me, { workspaceId: ws.id, title }).id);
    for (const id of ids) setReminder(me, id, { at: FUTURE });
    // 1件ずつ期限を来させ、そのたびに2つの接続で交互に届ける
    const counts: number[] = [];
    for (const [i, id] of ids.entries()) {
      db.query("UPDATE reminders SET remind_at = ? WHERE issue_id = (SELECT id FROM issues WHERE number = ?)").run(
        "2000-01-01T00:00:00.000Z",
        Number(id.split("-")[1]),
      );
      const [first, second] = i % 2 === 0 ? [db, other] : [other, db];
      counts.push(deliverDueReminders(first), deliverDueReminders(second));
    }
    expect(counts).toEqual([1, 0, 1, 0, 1, 0]);
    expect(listNotifications(other).map((n) => n.issueId).sort()).toEqual([...ids].sort());
    expect(db.query("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'reminder'").get()).toEqual({ n: 3 });
    other.close();
  });

  test("複数のプロセスが同時に届けても、リマインダーの数だけ通知を作る", async () => {
    const { db, ws, me } = setup();
    const n = 40;
    for (let i = 0; i < n; i++) setReminder(me, createIssue(me, { workspaceId: ws.id, title: `課題${i}` }).id, { at: FUTURE });
    makeDue(db);
    const src = new URL("../src/ops/reminders.ts", import.meta.url).pathname;
    const dbSrc = new URL("../src/db.ts", import.meta.url).pathname;
    const startAt = Date.now() + 700;
    // 開始時刻を揃え、各プロセスが何度も届けようとする
    const script = `import { openDb } from ${JSON.stringify(dbSrc)}; import { deliverDueReminders } from ${JSON.stringify(src)};
      const db = openDb(${JSON.stringify(db.filename)}); while (Date.now() < ${startAt}) {}
      let sum = 0; for (let i = 0; i < 20; i++) sum += deliverDueReminders(db); console.log(sum);`;
    const procs = Array.from({ length: 4 }, () => Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" }));
    const outs = await Promise.all(procs.map(async (p) => {
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      return Number(out.trim());
    }));
    expect(outs.reduce((a, b) => a + b, 0)).toBe(n);
    expect(db.query("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'reminder'").get()).toEqual({ n });
    expect(db.query("SELECT COUNT(DISTINCT issue_id) AS n FROM notifications WHERE kind = 'reminder'").get()).toEqual({ n });
  });

  test("ほかの接続が書き込み中で届けられなくても、通知一覧と Issue 詳細は読めて、次に読んだとき届く", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    setReminder(me, a.id, { at: FUTURE });
    makeDue(db);
    const reader = openDb(db.filename, { busyTimeoutMs: 20 });
    db.exec("BEGIN IMMEDIATE");
    try {
      expect(listNotifications(reader)).toEqual([]);
      expect(getIssue(reader, a.id).id).toBe(a.id);
      expect(listReminders(reader)).toHaveLength(1);
    } finally {
      db.exec("COMMIT");
    }
    expect(listNotifications(reader)).toHaveLength(1);
    reader.close();
  });

  test("Issue を消すとリマインダーも消える", () => {
    const db = openDb(tempDbPath());
    expect(db.query("SELECT sql FROM sqlite_master WHERE name = 'reminders'").get()).toMatchObject({
      sql: expect.stringContaining("ON DELETE CASCADE"),
    });
  });
});
