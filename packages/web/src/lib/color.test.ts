import { describe, expect, test } from "bun:test";
import { agentColor, agentInitial, workspaceColor } from "./color";

describe("workspaceColor", () => {
  test("キーの文字コードの和を4で割った余りで色を選ぶ", () => {
    expect(workspaceColor("BLOG")).toBe("var(--ws-a)");
    expect(workspaceColor("NOD")).toBe("var(--ws-b)");
    expect(workspaceColor("API")).toBe("var(--ws-c)");
  });

  test("同じキーは常に同じ色", () => {
    expect(workspaceColor("API")).toBe(workspaceColor("API"));
  });
});

describe("書き手の表示", () => {
  test("claude-code と codex は nod.pen の色と頭文字を使う", () => {
    expect(agentColor("claude-code")).toBe("var(--claude)");
    expect(agentColor("codex")).toBe("var(--codex)");
    expect(agentColor("me")).toBe("var(--accent)");
    expect(agentColor("gemini")).toBe("var(--gate)");
    expect(agentInitial("claude-code")).toBe("C");
    expect(agentInitial("codex")).toBe("X");
    expect(agentInitial("me")).toBe("M");
    expect(agentInitial("")).toBe("?");
  });
});
