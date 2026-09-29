import { describe, expect, test } from "bun:test";
import type { AgentState, Question } from "../api/types";
import { awaitingQuestions } from "./awaiting-input";

const q = (id: number, askedBy = "codex", answer: string | null = null, askedAt = "2026-09-28T09:00:00Z"): Question => ({
  id, issueId: "API-1", question: `質問${id}`, askedBy, askedAt, answer, answeredBy: null, answeredAt: null,
});

describe("回答待ちバナーの対象", () => {
  test("人と回答済みを除き、任意LLMの質問を日時とIDの順で選ぶ", () => {
    const questions = [q(5), q(4, "任意LLM"), q(3, "me"), q(2, "codex", "回答"), q(9, "claude-code", null, "2026-09-27T10:00:00Z")];
    expect(awaitingQuestions({ agentState: "awaiting_input", questions }).map((q) => q.id)).toEqual([9, 4, 5]);
    expect(questions.map((q) => q.id)).toEqual([5, 4, 3, 2, 9]);
  });
  test.each([null, "working", "error", "done"] as (AgentState | null)[])("%s は未回答があっても表示しない", (agentState) => {
    expect(awaitingQuestions({ agentState, questions: [q(1)] })).toEqual([]);
  });
  test("対象なしの入力待ちは表示しない", () => {
    for (const questions of [[], [q(1, "me")], [q(1, "codex", "済み")]]) {
      expect(awaitingQuestions({ agentState: "awaiting_input", questions })).toEqual([]);
    }
  });
});
