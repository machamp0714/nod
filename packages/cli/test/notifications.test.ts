import { expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

test("購読・解除・通知の一覧・既読を CLI で行え、LLM は購読を操作できない", async () => {
  const db = tempDb();
  const repo = makeRepo();
  registerRepo(db, repo, "API");
  const nod = (args: string[], actor = "me") => runNod(args, { cwd: repo, db, actor });

  await nod(["issue", "create", "検索", "--json"]);
  const denied = await nod(["issue", "subscribe", "API-1", "--json"], "claude-code");
  expect(denied.exitCode).toBe(1);
  expect(denied.json.error.code).toBe("FORBIDDEN_FOR_LLM");

  const on = await nod(["issue", "subscribe", "API-1"]);
  expect(on.exitCode).toBe(0);
  expect(on.stdout.trim()).toBe("API-1 を購読しました");
  expect((await nod(["issue", "show", "API-1"])).stdout).toContain("購読: 購読中");

  await nod(["issue", "update", "API-1", "--priority", "2"], "claude-code");
  await nod(["issue", "comment", "API-1", "原因がわかった"], "claude-code");
  await nod(["issue", "comment", "API-1", "自分のメモ"]);

  const inbox = await nod(["inbox"]);
  expect(inbox.stdout).toContain("通知（未読 2）");
  expect(inbox.stdout).toContain("claude-code がコメント: 原因がわかった");
  expect(inbox.stdout).toContain("claude-code が優先度を変更: なし → High");
  expect(inbox.stdout).not.toContain("自分のメモ");
  const inboxJson = await nod(["inbox", "--json"]);
  expect(Object.keys(inboxJson.json).sort()).toEqual(["notifications", "questions", "reviews"]);

  const list = await nod(["notification", "list", "--json"]);
  expect(list.json.map((n: { eventType: string }) => n.eventType)).toEqual(["comment_added", "priority_changed"]);
  const read = await nod(["notification", "read", String(list.json[0].id)]);
  expect(read.stdout.trim()).toBe("1 件を既読にしました");
  expect((await nod(["notification", "list", "--json"])).json).toHaveLength(1);
  expect((await nod(["notification", "list", "--include-read", "--json"])).json).toHaveLength(2);
  expect((await nod(["notification", "read", "--issue", "API-1", "--json"])).json).toEqual({ updated: 1 });
  expect((await nod(["notification", "read", "--all", "--json"])).json).toEqual({ updated: 0 });
  // 既読の上限（#98）
  expect((await nod(["notification", "list", "--include-read", "--limit", "1", "--json"])).json).toHaveLength(1);
  expect((await nod(["notification", "list", "--include-read", "--limit", "0", "--json"])).json.error.code).toBe("INVALID_ARGS");
  expect((await nod(["notification", "list", "--limit", "1", "--json"])).json.error.code).toBe("INVALID_ARGS");

  const none = await nod(["notification", "read", "--json"]);
  expect(none.exitCode).toBe(1);
  expect(none.json.error.code).toBe("INVALID_ARGS");
  const bad = await nod(["notification", "read", "abc", "--json"]);
  expect(bad.json.error.code).toBe("INVALID_ARGS");

  const off = await nod(["issue", "unsubscribe", "API-1"]);
  expect(off.stdout.trim()).toBe("API-1 の購読を解除しました");
  expect((await nod(["issue", "show", "API-1"])).stdout).not.toContain("購読: 購読中");
});

test("既読の通知を未読に戻せ、LLM は戻せない（#161）", async () => {
  const db = tempDb();
  const repo = makeRepo();
  registerRepo(db, repo, "API");
  const nod = (args: string[], actor = "me") => runNod(args, { cwd: repo, db, actor });

  await nod(["issue", "create", "検索", "--json"]);
  await nod(["issue", "subscribe", "API-1"]);
  await nod(["issue", "comment", "API-1", "原因がわかった"], "claude-code");
  await nod(["issue", "comment", "API-1", "直した"], "claude-code");
  await nod(["notification", "read", "--all"]);
  const all = (await nod(["notification", "list", "--include-read", "--json"])).json as { id: number; body: string }[];
  const first = all.find((n) => n.body === "原因がわかった")!;

  const denied = await nod(["notification", "unread", "--issue", "API-1", "--json"], "claude-code");
  expect(denied.exitCode).toBe(1);
  expect(denied.json.error.code).toBe("FORBIDDEN_FOR_LLM");
  expect((await nod(["notification", "list", "--json"])).json).toEqual([]);

  // --issue は最新の1件だけ、id は指定したものを戻す
  const byIssue = await nod(["notification", "unread", "--issue", "API-1"]);
  expect(byIssue.exitCode).toBe(0);
  expect(byIssue.stdout.trim()).toBe("1 件を未読に戻しました");
  expect((await nod(["notification", "list", "--json"])).json.map((n: { body: string }) => n.body)).toEqual(["直した"]);
  expect((await nod(["notification", "list"])).stdout).toContain(" *  API-1");
  expect((await nod(["inbox"])).stdout).toContain("通知（未読 1）");
  expect((await nod(["notification", "unread", String(first.id), "--json"])).json).toEqual({ updated: 1 });
  expect((await nod(["notification", "unread", String(first.id), "--json"])).json).toEqual({ updated: 0 });
  expect((await nod(["notification", "list", "--json"])).json).toHaveLength(2);

  for (const args of [[], [String(first.id), "--issue", "API-1"], ["abc"]]) {
    const r = await nod(["notification", "unread", ...args, "--json"]);
    expect(r.exitCode).toBe(1);
    expect(r.json.error.code).toBe("INVALID_ARGS");
  }
  expect((await nod(["notification", "unread", "9999", "--json"])).json.error.code).toBe("NOT_FOUND");
  expect((await nod(["notification", "unread", "--issue", "API-9", "--json"])).json.error.code).toBe("NOT_FOUND");
});

test("通知をスヌーズ・解除でき、LLM は操作できない（#43）", async () => {
  const db = tempDb();
  const repo = makeRepo();
  registerRepo(db, repo, "API");
  const nod = (args: string[], actor = "me") => runNod(args, { cwd: repo, db, actor });

  await nod(["issue", "create", "検索", "--json"]);
  await nod(["issue", "subscribe", "API-1"]);
  await nod(["issue", "comment", "API-1", "原因がわかった"], "claude-code");

  const denied = await nod(["notification", "snooze", "--issue", "API-1", "--until", "2999-01-01", "--json"], "claude-code");
  expect(denied.json.error.code).toBe("FORBIDDEN_FOR_LLM");

  const snooze = await nod(["notification", "snooze", "--issue", "API-1", "--until", "2999-01-01T09:00:00+09:00"]);
  expect(snooze.exitCode).toBe(0);
  expect(snooze.stdout.trim()).toBe("1 件を 2999-01-01T00:00:00.000Z までスヌーズしました");
  expect((await nod(["notification", "list", "--include-read", "--json"])).json).toEqual([]);
  const snoozed = await nod(["notification", "list", "--snoozed"]);
  expect(snoozed.stdout).toContain("スヌーズ中（2999-01-01T00:00:00.000Z まで）");

  const past = await nod(["notification", "snooze", "--issue", "API-1", "--until", "2000-01-01", "--json"]);
  expect(past.json.error.code).toBe("INVALID_ARGS");
  const conflict = await nod(["notification", "list", "--snoozed", "--include-read", "--json"]);
  expect(conflict.json.error.code).toBe("INVALID_ARGS");

  const un = await nod(["notification", "unsnooze", "--issue", "API-1"]);
  expect(un.stdout.trim()).toBe("1 件のスヌーズを解除しました");
  expect((await nod(["notification", "list", "--json"])).json).toHaveLength(1);
});

test("通知を削除・取り消しでき、LLM は削除できない（#44）", async () => {
  const db = tempDb();
  const repo = makeRepo();
  registerRepo(db, repo, "API");
  const nod = (args: string[], actor = "me") => runNod(args, { cwd: repo, db, actor });

  await nod(["issue", "create", "検索", "--json"]);
  await nod(["issue", "subscribe", "API-1"]);
  await nod(["issue", "comment", "API-1", "原因がわかった"], "claude-code");

  const denied = await nod(["notification", "delete", "--issue", "API-1", "--json"], "claude-code");
  expect(denied.json.error.code).toBe("FORBIDDEN_FOR_LLM");

  const del = await nod(["notification", "delete", "--issue", "API-1"]);
  expect(del.exitCode).toBe(0);
  const [, id] = /取り消すには nod notification restore (\d+)/.exec(del.stdout) ?? [];
  expect(del.stdout).toContain("1 件を削除しました");
  expect((await nod(["notification", "list", "--include-read", "--json"])).json).toEqual([]);

  const restore = await nod(["notification", "restore", id!]);
  expect(restore.stdout.trim()).toBe("1 件の削除を取り消しました");
  expect((await nod(["notification", "list", "--json"])).json).toHaveLength(1);
  const missing = await nod(["notification", "restore", id!, "9999"]);
  expect(missing.stdout.trim()).toBe("0 件の削除を取り消しました（1 件はもうないため読み飛ばしました）");
  const none = await nod(["notification", "restore", "--json"]);
  expect(none.json.error.code).toBe("INVALID_ARGS");
});

test("通知の要約は種別ごとに変化を表す", async () => {
  const { describeNotification } = await import("../src/output");
  const base = { id: 1, kind: "issue_change", issueId: "API-1", issueTitle: "t", workspace: "API", actor: "codex", body: null, createdAt: "", readAt: null, snoozedUntil: null };
  const say = (eventType: string, data: Record<string, unknown> = {}, body: string | null = null) =>
    describeNotification({ ...base, eventType, data, body });
  expect(say("status_changed", { from: "in_progress", to: "in_review" })).toBe("codex がステータスを変更: In Progress → In Review");
  expect(say("assignee_changed", { from: null, to: "codex" })).toBe("codex が担当を変更: なし → codex");
  expect(say("labels_changed", { added: ["bug"], removed: ["ui"] })).toBe("codex がラベルを変更: +bug -ui");
  expect(say("review_rejected", { reason: "直して" })).toBe("codex が差し戻し: 直して");
  expect(say("triage_accepted")).toBe("codex が Triage を受け入れ");
  expect(say("agent_state_changed", { from: "working", to: "done", agent: "codex" })).toBe("codex が作業を完了（レビュー待ち）");
  expect(say("agent_state_changed", { from: "working", to: "awaiting_input", reason: "進めてよいか" })).toBe("codex が確認を求めた（入力待ち）: 進めてよいか");
  expect(say("agent_state_changed", { from: "working", to: "error", reason: "落ちた" })).toBe("codex がエラーで停止: 落ちた");
  // 操作したのが別の LLM でも、主語は担当（data.agent）
  expect(say("agent_state_changed", { from: "working", to: "error", reason: "落ちた", agent: "claude-code" })).toBe("claude-code がエラーで停止: 落ちた");
});

test("購読していなくても、LLM に任せた Issue の完了・入力待ちが inbox と通知一覧に届く（#54）", async () => {
  const db = tempDb();
  const repo = makeRepo();
  registerRepo(db, repo, "API");
  const nod = (args: string[], actor = "me") => runNod(args, { cwd: repo, db, actor });

  await nod(["issue", "create", "検索", "--json"]);
  await nod(["issue", "start", "API-1"], "claude-code");
  await nod(["issue", "ask", "API-1", "進めてよいか"], "claude-code");
  const inbox = await nod(["inbox"]);
  expect(inbox.stdout).toContain("通知（未読 1）");
  expect(inbox.stdout).toContain("claude-code が確認を求めた（入力待ち）: 進めてよいか");

  await nod(["answer", "API-1", "よい"]);
  expect((await nod(["notification", "list", "--json"])).json).toEqual([]);
  await nod(["issue", "done", "API-1", "--summary", "直した"], "claude-code");
  const list = await nod(["notification", "list", "--json"]);
  expect(list.json.map((n: { kind: string; data: { to: string } }) => [n.kind, n.data.to])).toEqual([["agent", "done"]]);
});
