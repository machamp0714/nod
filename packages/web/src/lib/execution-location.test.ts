import { expect, test } from "bun:test";
import { executionLocation } from "./execution-location";

test("worktreeだけでもdetachedとして実行場所を示す", () => {
  expect(executionLocation(null, "/作業/日本語のパス")).toEqual({ branchLabel: "(detached)", worktree: "/作業/日本語のパス" });
  expect(executionLocation("main", "/wt/main")).toEqual({ branchLabel: "main", worktree: "/wt/main" });
  expect(executionLocation("main", null)).toEqual({ branchLabel: "main", worktree: null });
  expect(executionLocation(null, null)).toBeNull();
});
