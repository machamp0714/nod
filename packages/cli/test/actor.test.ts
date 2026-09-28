import { describe, expect, test } from "bun:test";
import { detectActor } from "../src/actor";

describe("detectActor", () => {
  test("NOD_ACTOR を最優先する", () => {
    expect(detectActor({ NOD_ACTOR: "codex", CLAUDECODE: "1" })).toBe("codex");
  });
  test("Claude Code の中なら claude-code", () => {
    expect(detectActor({ CLAUDECODE: "1" })).toBe("claude-code");
  });
  test("どちらもなければ me", () => {
    expect(detectActor({})).toBe("me");
  });
});
