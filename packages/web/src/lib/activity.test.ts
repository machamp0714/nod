import { describe, expect, test } from "bun:test";
import { describeActivity } from "./activity";

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
    expect(describeActivity({ kind: "comment", at, actor: "codex", body: "原因がわかった" })).toEqual({ icon: "message-square", text: "原因がわかった" });
    expect(describeActivity({ kind: "event", at, actor: "me", type: "snoozed", data: {} }).text).toBe("me: snoozed");
  });
});
