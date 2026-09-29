import { describe, expect, test } from "bun:test";
import { agentColor, agentInitial } from "./color";

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
