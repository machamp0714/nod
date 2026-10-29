import { describe, expect, test } from "bun:test";
import { assigneeChoices, descriptionInput, hasText, parseLabels, statusChoices } from "./issue-edit";

describe("statusChoices", () => {
  test("Needs Clarification は選べない。今の値のときだけ、選べない項目として出す", () => {
    const todo = statusChoices("todo");
    expect(todo.map((c) => c.value)).toEqual(["triage", "backlog", "todo", "in_progress", "in_review", "done", "canceled"]);
    expect(todo.every((c) => !c.disabled)).toBe(true);
    const nc = statusChoices("needs_clarification");
    expect(nc.find((c) => c.value === "needs_clarification")).toEqual({
      value: "needs_clarification",
      label: "Needs Clarification",
      disabled: true,
    });
  });
});

describe("assigneeChoices", () => {
  test("既知の担当者に、それ以外の今の担当者を足す", () => {
    expect(assigneeChoices(null)).toEqual(["me", "claude-code", "codex"]);
    expect(assigneeChoices("codex")).toEqual(["me", "claude-code", "codex"]);
    expect(assigneeChoices("gemini")).toEqual(["me", "claude-code", "codex", "gemini"]);
  });
});

describe("parseLabels", () => {
  test("空白、カンマ、読点で区切り、重複と付いているラベルを除く", () => {
    expect(parseLabels("api, docs　perf、api", ["perf"])).toEqual(["api", "docs"]);
    expect(parseLabels("  ", [])).toEqual([]);
  });
});

describe("descriptionInput と hasText", () => {
  test("空白だけの説明は null にし、それ以外はそのまま送る", () => {
    expect(descriptionInput("  \n ")).toBeNull();
    expect(descriptionInput("## 手順\n")).toBe("## 手順\n");
    expect(hasText(" \n")).toBe(false);
    expect(hasText(" a ")).toBe(true);
  });
});
