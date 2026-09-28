import { describe, expect, test } from "bun:test";
import { parsePlanMarkdown, rollup } from "../src/plan-markdown";

const md = [
  "# 検索の実装計画",
  "",
  "### Task 1: 土台を作る",
  "",
  "- [x] **Step 1: テストを書く**",
  "- [x] **Step 2: 実装する**",
  "",
  "```md",
  "### Task 99: コードブロックの中は無視する",
  "- [ ] **Step 1: これも無視する**",
  "```",
  "",
  "### Task 2: 変換を書く",
  "",
  "- [X] **Step 1: テストを書く**",
  "- [ ] **Step 2: 実装する**",
  "",
  "````markdown",
  "```ts",
  "### Task 98: 4つのバッククォートの中も無視する",
  "```",
  "````",
  "",
  "### Task 3：仕上げる",
].join("\n");

describe("parsePlanMarkdown", () => {
  test("Task 見出しと Step のチェックボックスを取り込み、Task の状態を揃える", () => {
    expect(parsePlanMarkdown(md)).toEqual([
      {
        title: "土台を作る",
        status: "done",
        steps: [
          { title: "テストを書く", status: "done" },
          { title: "実装する", status: "done" },
        ],
      },
      {
        title: "変換を書く",
        status: "doing",
        steps: [
          { title: "テストを書く", status: "done" },
          { title: "実装する", status: "pending" },
        ],
      },
      { title: "仕上げる", status: "pending", steps: [] },
    ]);
  });

  test("Task 見出しがなければ空", () => {
    expect(parsePlanMarkdown("# 見出しだけ\n\n- [ ] **Step 1: 迷子**\n")).toEqual([]);
  });
});

describe("rollup", () => {
  test("Step がなければ Task 自身の状態を保つ", () => {
    expect(rollup([], "doing")).toBe("doing");
  });
  test("done と skipped だけなら done、進んだ Step があれば doing、すべて pending なら pending", () => {
    expect(rollup([{ title: "a", status: "done" }, { title: "b", status: "skipped" }], "pending")).toBe("done");
    expect(rollup([{ title: "a", status: "doing" }, { title: "b", status: "pending" }], "pending")).toBe("doing");
    expect(rollup([{ title: "a", status: "pending" }], "done")).toBe("pending");
  });
});
