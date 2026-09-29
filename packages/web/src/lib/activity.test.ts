import { describe, expect, test } from "bun:test";
import { attachmentSourcePath, describeActivity, visibleActivity } from "./activity";

const at = "2026-09-28T00:00:00.000Z";

describe("describeActivity", () => {
  test("書き手つきの文にする", () => {
    expect(describeActivity({ kind: "event", at, actor: "me", type: "created", data: { status: "todo" } }).text).toBe("me が起票した");
    expect(describeActivity({ kind: "event", at, actor: "me", type: "created", data: { status: "todo", copied_from: "API-1" } })).toEqual({
      icon: "copy",
      text: "me が API-1 から複製した",
    });
    expect(
      describeActivity({ kind: "event", at, actor: "claude-code", type: "status_changed", data: { from: "todo", to: "in_progress" } }).text,
    ).toBe("claude-code がステータスを Todo から In Progress に変えた");
    expect(
      describeActivity({ kind: "event", at, actor: "claude-code", type: "agent_state_changed", data: { from: "working", to: "awaiting_input" } })
        .text,
    ).toBe("claude-code が作業状況を 入力待ち に変えた");
  });

  test("質問は未回答と回答済みで文を変える", () => {
    const base = { kind: "question" as const, at, actor: "claude-code", question: "消してよいですか？" };
    expect(describeActivity({ ...base, answer: null, answeredBy: null, answeredAt: null }).text).toBe(
      "claude-code が確認を求めた：消してよいですか？",
    );
    expect(describeActivity({ ...base, answer: "はい", answeredBy: "me", answeredAt: at }).text).toBe(
      "claude-code の確認依頼に me が回答した：消してよいですか？",
    );
  });

  test("コメントは本文を、知らない種類は種類の名前を出す", () => {
    expect(describeActivity({ kind: "comment", id: 1, at, actor: "codex", body: "原因がわかった", replies: [], resolvedAt: null, resolvedBy: null, logKind: null })).toEqual({
      icon: "message-square",
      text: "codex：原因がわかった",
    });
    expect(describeActivity({ kind: "event", at, actor: "me", type: "snoozed", data: {} }).text).toBe("me: snoozed");
  });
});

describe("describeActivity の event の種類", () => {
  const text = (type: string, data: Record<string, unknown>) => describeActivity({ kind: "event", at, actor: "me", type, data }).text;

  test("変わる前と後を書き手つきの文にする", () => {
    expect(text("priority_changed", { from: 0, to: 1 })).toBe("me が優先度を No priority から Urgent に変えた");
    expect(text("assignee_changed", { from: null, to: "codex" })).toBe("me が担当者を なし から codex に変えた");
    expect(text("description_changed", { from: "a", to: "b" })).toBe("me が説明を変えた");
    expect(text("labels_changed", { added: ["api"], removed: ["perf"] })).toBe("me がラベルを変えた（+api −perf）");
    expect(text("relation_added", { type: "blocks", to: "API-13" })).toBe("me が関連 Issue を足した：blocks API-13");
    expect(text("estimate_changed", { from: null, to: 3 })).toBe("me が見積もりを なし から 3 pt に変えた");
    expect(text("estimate_changed", { from: 3, to: null })).toBe("me が見積もりを 3 pt から なし に変えた");
    expect(text("due_date_changed", { from: null, to: "2026-10-01" })).toBe("me が期限を なし から 2026-10-01 に変えた");
  });

  test("判断の event は理由があれば続ける", () => {
    expect(text("triage_accepted", {})).toBe("me が受け入れた");
    expect(text("review_rejected", { reason: "テストが足りない" })).toBe("me が差し戻した：テストが足りない");
  });

  test("スレッドの解決と未解決への戻しを書き手つきの文にする", () => {
    expect(text("comment_thread_resolved", { comment_id: 1 })).toBe("me がコメントのスレッドを解決済みにした");
    expect(text("comment_thread_reopened", { comment_id: 1 })).toBe("me がコメントのスレッドを未解決に戻した");
  });
});

describe("visibleActivity", () => {
  test("質問の event は、同じ質問の行と重なるため除く", () => {
    const items = [
      { kind: "event" as const, at, actor: "codex", type: "question_asked", data: { question_id: 1 } },
      { kind: "question" as const, at, actor: "codex", question: "消してよいですか？", answer: null, answeredBy: null, answeredAt: null },
      { kind: "event" as const, at, actor: "me", type: "question_answered", data: { question_id: 1 } },
      { kind: "comment" as const, id: 1, at, actor: "me", body: "了解", replies: [], resolvedAt: null, resolvedBy: null, logKind: null },
    ];
    expect(visibleActivity(items).map((i) => i.kind)).toEqual(["question", "comment"]);
  });
});

test("回答済み質問は回答日時の位置に表示し、元の Activity を変更しない", () => {
  const askedAt = "2026-09-27T09:00:00.000Z";
  const answeredAt = "2026-09-28T09:00:00.000Z";
  const question = {
    kind: "question" as const, at: askedAt, actor: "codex", question: "方針は？",
    answer: "進める", answeredBy: "me", answeredAt,
  };
  const comment = { kind: "comment" as const, id: 1, at: "2026-09-27T12:00:00.000Z", actor: "me", body: "検討中", replies: [], resolvedAt: null, resolvedBy: null, logKind: null };
  const open = { ...question, question: "別の質問", answer: null, answeredBy: null, answeredAt: null };
  const items = [question, open, comment];
  const visible = visibleActivity(items);
  expect(visible.map((item) => item.at)).toEqual([askedAt, comment.at, answeredAt]);
  expect(visible.map((item) => item.kind)).toEqual(["question", "comment", "question"]);
  expect(describeActivity(visible[2]!).text).toBe("codex の確認依頼に me が回答した：方針は？");
  expect(question.at).toBe(askedAt);
  expect(items[0]).toBe(question);
});

test("作業主体の記録を使い、旧eventのmeを作業者とみなさない", () => {
  const line = (actor: string, data: Record<string, unknown>) => describeActivity({ kind: "event", at, actor, type: "agent_state_changed", data: { to: "working", ...data } }).text;
  expect(line("me", { agent: "codex", trigger: "answer" })).toBe("me の回答で codex の作業状況が 作業中 になった");
  expect(line("other-agent", { agent: "codex", trigger: "answer" })).toBe("other-agent の回答で codex の作業状況が 作業中 になった");
  expect(line("me", { agent: "codex" })).toBe("me が codex の作業状況を 作業中 に変えた");
  expect(line("me", {})).toBe("me が作業状況を 作業中 に変えた");
  expect(line("me", { agent: null, trigger: "answer" })).toBe("me の回答で作業状況が 作業中 になった");
  expect(line("codex", { agent: null })).toBe("codex が作業状況を 作業中 に変えた");
});

test("作業状況のnullは解除として表示し、記録された主体と旧履歴を区別する", () => {
  const line = (actor: string, data: Record<string, unknown>) => describeActivity({ kind: "event", at, actor, type: "agent_state_changed", data: { from: "working", to: null, ...data } }).text;
  expect(line("me", { agent: "codex" })).toBe("me が codex の作業状況を解除した");
  expect(line("codex", { agent: "codex" })).toBe("codex が codex の作業状況を解除した");
  expect(line("me", { agent: null })).toBe("me が作業状況を解除した");
  expect(line("me", {})).toBe("me が作業状況を解除した");
  expect(line("codex", {})).toBe("codex が作業状況を解除した");
});

test("アーカイブと復元を書き手つきで出し、理由があれば添える", () => {
  expect(describeActivity({ kind: "event", at, actor: "me", type: "archived", data: {} })).toEqual({ icon: "archive", text: "me がアーカイブした" });
  expect(describeActivity({ kind: "event", at, actor: "me", type: "archived", data: { reason: "不要" } }).text).toBe("me がアーカイブした：不要");
  expect(describeActivity({ kind: "event", at, actor: "me", type: "unarchived", data: {} })).toEqual({ icon: "archive-restore", text: "me がアーカイブから復元した" });
});

test("添付の元ファイルの場所は file の attachment_added だけから取り出し、本文には混ぜない", () => {
  const added = { kind: "event" as const, at, actor: "me", type: "attachment_added", data: { kind: "file", name: "a.log", source_path: "/repo/a.log" } };
  expect(attachmentSourcePath(added)).toBe("/repo/a.log");
  expect(describeActivity(added).text).toBe("me がファイルを添付した：a.log");
  expect(attachmentSourcePath({ ...added, data: { kind: "link", name: "e.com" } })).toBeNull();
  expect(attachmentSourcePath({ ...added, type: "attachment_removed" })).toBeNull();
});
