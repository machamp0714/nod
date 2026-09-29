import { describe, expect, test } from "bun:test";
import { askQuestion, completeIssue, failIssue, startIssue } from "../src/ops/agent";
import { acceptTriage, answerQuestion, approveReview, getInbox, rejectReview } from "../src/ops/human";
import { commentIssue, createIssue, getIssue, resolveThread, updateIssue } from "../src/ops/issues";
import {
  isSubscribed,
  listNotifications,
  markNotificationsRead,
  NOTIFY_EVENT_TYPES,
  subscribeIssue,
  unsubscribeIssue,
} from "../src/ops/notifications";
import { codeOf, setup } from "./helpers";

describe("購読の開始と解除", () => {
  test("me は購読を開始・解除でき、どちらも冪等", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    expect(getIssue(db, a.id).subscribed).toBe(false);

    expect(subscribeIssue(me, a.id)).toEqual({ issueId: a.id, subscribed: true });
    expect(subscribeIssue(me, a.id)).toEqual({ issueId: a.id, subscribed: true });
    expect(getIssue(db, a.id).subscribed).toBe(true);
    expect(isSubscribed(db, a.id)).toBe(true);

    expect(unsubscribeIssue(me, a.id)).toEqual({ issueId: a.id, subscribed: false });
    expect(unsubscribeIssue(me, a.id)).toEqual({ issueId: a.id, subscribed: false });
    expect(getIssue(db, a.id).subscribed).toBe(false);
  });

  test("LLM は購読を操作できず、存在しない Issue は NOT_FOUND", () => {
    const { ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    expect(codeOf(() => subscribeIssue(llm, a.id))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => unsubscribeIssue(llm, a.id))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => subscribeIssue(me, "API-999"))).toBe("NOT_FOUND");
  });
});

describe("購読中の Issue の変化の通知", () => {
  test("対象の種別を明示している", () => {
    expect([...NOTIFY_EVENT_TYPES].sort() as string[]).toEqual(
      [
        "assignee_changed",
        "comment_added",
        "due_date_changed",
        "estimate_changed",
        "labels_changed",
        "priority_changed",
        "project_changed",
        "review_approved",
        "review_rejected",
        "status_changed",
        "title_changed",
        "triage_accepted",
        "triage_declined",
      ].sort(),
    );
  });

  test("LLM の状態・担当・コメントの変化が通知になり、新しい順に並ぶ", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    subscribeIssue(me, a.id);
    updateIssue(llm, a.id, { assignee: "claude-code", priority: 2, addLabels: ["bug"] });
    commentIssue(llm, a.id, "原因がわかった");

    const list = listNotifications(db);
    expect(list.map((n) => n.eventType).sort()).toEqual(["assignee_changed", "comment_added", "labels_changed", "priority_changed"]);
    expect(list[0]).toEqual(
      expect.objectContaining({
        kind: "issue_change",
        issueId: a.id,
        issueTitle: "検索",
        workspace: "API",
        eventType: "comment_added",
        actor: "claude-code",
        body: "原因がわかった",
        readAt: null,
      }),
    );
    const assignee = list.find((n) => n.eventType === "assignee_changed");
    expect(assignee?.data).toEqual({ from: null, to: "claude-code" });
  });

  test("見積もり・期限の変化も優先度と同じく通知になる", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    subscribeIssue(me, a.id);
    updateIssue(llm, a.id, { estimate: 5, dueDate: "2026-10-15" });
    updateIssue(me, a.id, { estimate: 8 });

    const list = listNotifications(db);
    expect(list.map((n) => [n.eventType, n.actor, n.data]).sort()).toEqual([
      ["due_date_changed", "claude-code", { from: null, to: "2026-10-15" }],
      ["estimate_changed", "claude-code", { from: null, to: 5 }],
    ]);
  });

  test("自分自身の操作では自分に通知しない", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    subscribeIssue(me, a.id);
    updateIssue(me, a.id, { status: "todo", priority: 1 });
    commentIssue(me, a.id, "メモ");
    expect(listNotifications(db, { includeRead: true })).toEqual([]);
  });

  test("購読していない Issue、解除後の変化、対象外の種別は通知しない", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    const b = createIssue(me, { workspaceId: ws.id, title: "画面" });
    subscribeIssue(me, a.id);
    commentIssue(llm, b.id, "他の Issue");
    startIssue(llm, a.id);
    const afterStart = listNotifications(db).map((n) => n.eventType).sort();
    // 着手で起きる agent_state_changed は対象外。状態と担当の変化だけが届く
    expect(afterStart).toEqual(["assignee_changed", "status_changed"]);
    askQuestion(llm, a.id, "進めてよいか");
    // 確認依頼（question_asked）は既存の Inbox の確認依頼で届くので、購読の通知にしない。
    // 入力待ちになったことは LLM の作業の通知（#54）で1件だけ届く
    const afterAsk = [...afterStart, "agent_state_changed"].sort();
    expect(listNotifications(db).map((n) => n.eventType).sort()).toEqual(afterAsk);
    expect(getInbox(db).questions).toHaveLength(1);

    unsubscribeIssue(me, a.id);
    commentIssue(llm, a.id, "解除後");
    expect(listNotifications(db).map((n) => n.eventType).sort()).toEqual(afterAsk);
  });

  test("1つのイベントから通知は1件だけで、再購読しても過去の変化は作り直さない", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    subscribeIssue(me, a.id);
    commentIssue(llm, a.id, "一度だけ");
    unsubscribeIssue(me, a.id);
    subscribeIssue(me, a.id);
    subscribeIssue(me, a.id);
    expect(listNotifications(db)).toHaveLength(1);
    const dup = db.query("SELECT COUNT(*) AS n FROM notifications GROUP BY recipient, comment_id HAVING n > 1").all();
    expect(dup).toEqual([]);
  });

  test("差し戻しと完了報告も届き、既存の Inbox の中身は変わらない", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    subscribeIssue(me, a.id);
    startIssue(llm, a.id);
    completeIssue(llm, a.id, { summary: "直した" });
    const types = listNotifications(db).map((n) => n.eventType);
    // 完了報告のコメントとレビューへの移動は、LLM の完了の通知1件にまとまる（#54）
    expect(types).not.toContain("comment_added");
    expect(types.filter((t) => t === "status_changed")).toHaveLength(1);
    expect(listNotifications(db)[0]).toEqual(expect.objectContaining({ kind: "agent", eventType: "agent_state_changed", data: expect.objectContaining({ to: "done" }) }));
    expect(getInbox(db).reviews.map((i) => i.id)).toEqual([a.id]);
    rejectReview(me, a.id, "やり直し");
    // 自分の差し戻しは届かず、応じた LLM の完了の通知は既読になる
    expect(listNotifications(db).map((n) => n.eventType)).toEqual(types.filter((t) => t !== "agent_state_changed"));
  });
});

describe("1つの判断の操作は1件の通知にまとめる", () => {
  test("差し戻し・承認・Triage の受け入れは、その操作を表す1件だけが届く", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    subscribeIssue(me, a.id);
    startIssue(llm, a.id);
    completeIssue(llm, a.id, { summary: "直した" });
    markNotificationsRead(me, { all: true });
    rejectReview(llm, a.id, "テストが足りない");
    expect(listNotifications(db).map((n) => [n.eventType, n.data])).toEqual([["review_rejected", { reason: "テストが足りない" }]]);

    // me 以外の購読者（将来の複数人）でも、me の判断は1件にまとまる
    const now = new Date().toISOString();
    const b = createIssue(llm, { workspaceId: ws.id, title: "画面" });
    const internal = (ref: string) => (db.query("SELECT i.id FROM issues i WHERE i.number = ?").get(Number(ref.split("-")[1])) as { id: number }).id;
    db.query("INSERT INTO subscriptions (issue_id, subscriber, created_at) VALUES (?, 'other', ?)").run(internal(b.id), now);
    acceptTriage(me, b.id, { priority: 2, addLabels: ["bug"] });
    const other = listNotifications(db, { recipient: "other" });
    expect(other.map((n) => n.eventType)).toEqual(["triage_accepted"]);
    db.query("INSERT INTO subscriptions (issue_id, subscriber, created_at) VALUES (?, 'other', ?)").run(internal(a.id), now);
    startIssue(llm, a.id);
    completeIssue(llm, a.id, { summary: "再度直した" });
    markNotificationsRead({ db, actor: "me" }, { all: true });
    const before = listNotifications(db, { recipient: "other" }).length;
    approveReview(me, a.id);
    const after = listNotifications(db, { recipient: "other" });
    expect(after.length - before).toBe(1);
    expect(after[0]?.eventType).toBe("review_approved");
  });
});

describe("通知の既読", () => {
  function seeded() {
    const s = setup();
    const a = createIssue(s.me, { workspaceId: s.ws.id, title: "検索" });
    const b = createIssue(s.me, { workspaceId: s.ws.id, title: "画面" });
    subscribeIssue(s.me, a.id);
    subscribeIssue(s.me, b.id);
    commentIssue(s.llm, a.id, "a1");
    commentIssue(s.llm, a.id, "a2");
    commentIssue(s.llm, b.id, "b1");
    return { ...s, a, b };
  }

  test("id を指定して既読にすると、既定の一覧から消え includeRead で残る", () => {
    const { db, me } = seeded();
    const [first] = listNotifications(db);
    const r = markNotificationsRead(me, { ids: [first!.id] });
    expect(r.updated).toBe(1);
    expect(listNotifications(db)).toHaveLength(2);
    const all = listNotifications(db, { includeRead: true });
    expect(all).toHaveLength(3);
    expect(all.find((n) => n.id === first!.id)?.readAt).not.toBeNull();
    // 既読のものを再度既読にしても件数は増えず、エラーにもならない
    expect(markNotificationsRead(me, { ids: [first!.id] }).updated).toBe(0);
  });

  test("Issue 単位とすべてを既読にできる", () => {
    const { db, me, a } = seeded();
    expect(markNotificationsRead(me, { issueRef: a.id }).updated).toBe(2);
    expect(listNotifications(db).map((n) => n.body)).toEqual(["b1"]);
    expect(markNotificationsRead(me, { all: true }).updated).toBe(1);
    expect(listNotifications(db)).toEqual([]);
  });

  test("LLM は通知を既読にできない", () => {
    const { db, llm } = seeded();
    expect(codeOf(() => markNotificationsRead(llm, { all: true }))).toBe("FORBIDDEN_FOR_LLM");
    expect(listNotifications(db)).toHaveLength(3);
  });

  test("指定がない・存在しない id・複数指定は INVALID_ARGS か NOT_FOUND", () => {
    const { me, a } = seeded();
    expect(codeOf(() => markNotificationsRead(me, {}))).toBe("INVALID_ARGS");
    expect(codeOf(() => markNotificationsRead(me, { all: true, issueRef: a.id }))).toBe("INVALID_ARGS");
    expect(codeOf(() => markNotificationsRead(me, { ids: [9999] }))).toBe("NOT_FOUND");
    expect(codeOf(() => markNotificationsRead(me, { ids: [0] }))).toBe("INVALID_ARGS");
  });

  test("スヌーズ中・削除済みの通知は一覧に出さない（#43・#44 の列）", () => {
    const { db } = seeded();
    const [first, second] = listNotifications(db);
    db.query("UPDATE notifications SET snoozed_until = ? WHERE id = ?").run("2999-01-01T00:00:00.000Z", first!.id);
    db.query("UPDATE notifications SET deleted_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", second!.id);
    expect(listNotifications(db, { includeRead: true })).toHaveLength(1);
  });
});

describe("コメントのスレッドへの返信（#48）", () => {
  test("返信も返信への返信も、それぞれ新規コメントの通知になり、本文は返信の本文", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    subscribeIssue(me, a.id);
    const root = commentIssue(llm, a.id, "親");
    const reply = commentIssue(llm, a.id, "返信", { replyTo: root.id });
    commentIssue(llm, a.id, "返信への返信", { replyTo: reply.id });
    const got = listNotifications(db);
    expect(got.map((n) => [n.eventType, n.body])).toEqual([
      ["comment_added", "返信への返信"],
      ["comment_added", "返信"],
      ["comment_added", "親"],
    ]);
  });

  test("自分の返信は通知せず、スレッドの解決・再開は通知しない", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    subscribeIssue(me, a.id);
    const root = commentIssue(llm, a.id, "親");
    commentIssue(me, a.id, "自分の返信", { replyTo: root.id });
    resolveThread(me, a.id, root.id, true);
    resolveThread(me, a.id, root.id, false);
    expect(listNotifications(db).map((n) => n.body)).toEqual(["親"]);
  });

  test("スレッドの親を消すと、返信の通知も一緒に消える", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    subscribeIssue(me, a.id);
    const root = commentIssue(llm, a.id, "親");
    commentIssue(llm, a.id, "返信", { replyTo: root.id });
    db.query("DELETE FROM comments WHERE id = ?").run(root.id);
    expect(listNotifications(db)).toEqual([]);
  });
});

describe("LLM に任せた Issue の作業の通知（#54）", () => {
  const agentOf = (db: ReturnType<typeof setup>["db"]) =>
    listNotifications(db, { includeRead: true }).filter((n) => n.kind === "agent");

  test("購読していなくても、完了・入力待ち・エラーが me に届く", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    startIssue(llm, a.id);
    // 着手（working）は通知しない
    expect(listNotifications(db)).toEqual([]);

    askQuestion(llm, a.id, "N+1 はどこまで直すか");
    // 2問目は入力待ちのままなので、新しい通知は作らない
    askQuestion(llm, a.id, "テストも足すか");
    expect(listNotifications(db).map((n) => [n.kind, n.eventType, n.actor, n.data])).toEqual([
      ["agent", "agent_state_changed", "claude-code", { from: "working", to: "awaiting_input", reason: "N+1 はどこまで直すか", agent: "claude-code" }],
    ]);
    answerQuestion(me, a.id, "全部");

    failIssue(llm, a.id, "DB に接続できない");
    completeIssue(llm, a.id, { summary: "直した" });
    const list = agentOf(db);
    expect(list.map((n) => n.data.to)).toEqual(["done", "error", "awaiting_input"]);
    expect(list[1]?.data.reason).toBe("DB に接続できない");
    expect(list.every((n) => n.issueId === a.id && n.issueTitle === "検索")).toBe(true);
  });

  test("担当が LLM でない Issue や、me 自身の操作では届かない", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    startIssue(me, a.id);
    failIssue(me, a.id, "自分で止めた");
    completeIssue(me, a.id, { summary: "自分で直した" });
    // 着手前の LLM の質問は確認依頼（needs_clarification）だけで、入力待ちの通知にしない
    const b = createIssue(me, { workspaceId: ws.id, title: "画面" });
    askQuestion(llm, b.id, "どの画面か");
    expect(listNotifications(db, { includeRead: true })).toEqual([]);
    expect(getInbox(db).questions).toHaveLength(1);
  });

  test("購読中でも、完了・エラーで同時に起きた変化は LLM の通知1件にまとめる", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    subscribeIssue(me, a.id);
    startIssue(llm, a.id);
    markNotificationsRead(me, { all: true });

    failIssue(llm, a.id, "落ちた");
    expect(listNotifications(db).map((n) => [n.kind, n.data.to])).toEqual([["agent", "error"]]);
    markNotificationsRead(me, { all: true });

    completeIssue(llm, a.id, { summary: "直した", prUrl: "https://example.com/pr/1" });
    expect(listNotifications(db).map((n) => [n.kind, n.data.to])).toEqual([["agent", "done"]]);
    // 1つのイベントから同じ宛先に2件は作らない
    const dup = db.query("SELECT COUNT(*) AS n FROM notifications GROUP BY recipient, event_id HAVING n > 1").all();
    expect(dup).toEqual([]);
  });

  test("me 以外の購読者の通知はまとめずに残す", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    const internal = (db.query("SELECT id FROM issues WHERE title = '検索'").get() as { id: number }).id;
    db.query("INSERT INTO subscriptions (issue_id, subscriber, created_at) VALUES (?, 'other', ?)").run(internal, new Date().toISOString());
    startIssue(llm, a.id);
    const before = listNotifications(db, { recipient: "other" }).length;
    completeIssue(llm, a.id, { summary: "直した" });
    const other = listNotifications(db, { recipient: "other" });
    expect(other.length - before).toBe(2);
    expect(other.every((n) => n.kind === "issue_change")).toBe(true);
    expect(agentOf(db).map((n) => n.data.to)).toEqual(["done"]);
  });

  test("me が回答・承認・差し戻しをすると、その Issue の未読の LLM の通知を既読にする", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    const b = createIssue(me, { workspaceId: ws.id, title: "画面" });
    subscribeIssue(me, a.id);
    startIssue(llm, a.id);
    startIssue(llm, b.id);
    markNotificationsRead(me, { all: true });
    askQuestion(llm, a.id, "進めてよいか");
    askQuestion(llm, b.id, "こちらも");
    commentIssue(llm, a.id, "補足");
    answerQuestion(me, a.id, "よい");
    // 回答した Issue の LLM の通知だけが既読になり、購読の通知と他の Issue は残る
    expect(listNotifications(db).map((n) => [n.issueId, n.kind])).toEqual([
      [a.id, "issue_change"],
      [b.id, "agent"],
    ]);

    completeIssue(llm, a.id, { summary: "直した" });
    expect(listNotifications(db).filter((n) => n.kind === "agent").map((n) => n.issueId)).toEqual([a.id, b.id]);
    rejectReview(me, a.id, "テスト不足");
    expect(listNotifications(db).filter((n) => n.kind === "agent").map((n) => n.issueId)).toEqual([b.id]);

    completeIssue(llm, a.id, { summary: "再度直した" });
    approveReview(me, a.id);
    expect(listNotifications(db).filter((n) => n.kind === "agent").map((n) => n.issueId)).toEqual([b.id]);
    // 既読にしただけで、履歴には残る
    expect(agentOf(db).filter((n) => n.issueId === a.id)).toHaveLength(3);
  });

  test("別の LLM が操作しても、通知には作業の担当（data.agent）を残す", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    startIssue(llm, a.id);
    failIssue({ db, actor: "codex" }, a.id, "落ちた");
    expect(agentOf(db).map((n) => [n.actor, n.data.agent, n.data.to])).toEqual([["codex", "claude-code", "error"]]);
  });

  test("回答で既読にするのは入力待ちが解けたときだけで、me 自身の質問への回答や未回答が残る回答では既読にしない", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索" });
    startIssue(llm, a.id);
    askQuestion(llm, a.id, "進めてよいか");
    askQuestion(llm, a.id, "テストも足すか");
    const unread = () => listNotifications(db).filter((n) => n.kind === "agent").map((n) => n.data.to);
    expect(unread()).toEqual(["awaiting_input"]);
    const llmQs = (db.query("SELECT id FROM questions WHERE asked_by <> 'me' ORDER BY id").all() as { id: number }[]).map((q) => q.id);

    // me 自身が作った未決事項への回答では既読にしない
    askQuestion(me, a.id, "自分用のメモ");
    const mine = (db.query("SELECT id FROM questions WHERE asked_by = 'me'").get() as { id: number }).id;
    answerQuestion(me, a.id, "あとで", { questionId: mine });
    expect(unread()).toEqual(["awaiting_input"]);

    // LLM の質問が残っている間は入力待ちのままなので既読にしない
    answerQuestion(me, a.id, "よい", { questionId: llmQs[0]! });
    expect(unread()).toEqual(["awaiting_input"]);

    // 最後の質問に答えて入力待ちが解けたら既読にする
    answerQuestion(me, a.id, "足す", { questionId: llmQs[1]! });
    expect(unread()).toEqual([]);
  });
});
