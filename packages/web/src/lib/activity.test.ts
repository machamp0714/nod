import { describe, expect, test } from "bun:test";
import { describeActivity, visibleActivity } from "./activity";

const at = "2026-09-28T00:00:00.000Z";

describe("describeActivity", () => {
  test("書き手つきの文にする", () => {
    expect(describeActivity({ kind: "event", at, actor: "me", type: "created", data: { status: "todo" } }).text).toBe("me が起票した");
    expect(
      describeActivity({ kind: "event", at, actor: "claude-code", type: "status_changed", data: { from: "todo", to: "in_progress" } }).text,
    ).toBe("claude-code がステータスを Todo から In Progress に変えた");
    expect(
      describeActivity({ kind: "event", at, actor: "claude-code", type: "agent_state_changed", data: { from: "working", to: "awaiting_input" } })
        .text,
    ).toBe("claude-code の作業状況が 入力待ち になった");
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
    expect(describeActivity({ kind: "comment", at, actor: "codex", body: "原因がわかった" })).toEqual({
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
  });

  test("判断の event は理由があれば続ける", () => {
    expect(text("triage_accepted", {})).toBe("me が受け入れた");
    expect(text("review_rejected", { reason: "テストが足りない" })).toBe("me が差し戻した：テストが足りない");
  });
});

describe("visibleActivity", () => {
  test("質問の event は、同じ質問の行と重なるため除く", () => {
    const items = [
      { kind: "event" as const, at, actor: "codex", type: "question_asked", data: { question_id: 1 } },
      { kind: "question" as const, at, actor: "codex", question: "消してよいですか？", answer: null, answeredBy: null, answeredAt: null },
      { kind: "event" as const, at, actor: "me", type: "question_answered", data: { question_id: 1 } },
      { kind: "comment" as const, at, actor: "me", body: "了解" },
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
  const comment = { kind: "comment" as const, at: "2026-09-27T12:00:00.000Z", actor: "me", body: "検討中" };
  const open = { ...question, question: "別の質問", answer: null, answeredBy: null, answeredAt: null };
  const items = [question, open, comment];
  const visible = visibleActivity(items);
  expect(visible.map((item) => item.at)).toEqual([askedAt, comment.at, answeredAt]);
  expect(visible.map((item) => item.kind)).toEqual(["question", "comment", "question"]);
  expect(describeActivity(visible[2]!).text).toBe("codex の確認依頼に me が回答した：方針は？");
  expect(question.at).toBe(askedAt);
  expect(items[0]).toBe(question);
});
