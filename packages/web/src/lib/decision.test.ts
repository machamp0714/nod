import { describe, expect, test } from "bun:test";
import type { InboxQuestion, Plan } from "../api/types";
import { doingTaskTitle, groupInbox, tomorrow, workspaceNameOf } from "./decision";

describe("workspaceNameOf", () => {
  test("キーから Workspace の名前を引き、見つからなければキーを返す", () => {
    const workspaces = [{ key: "API", name: "api-server" }];
    expect(workspaceNameOf(workspaces, "API")).toBe("api-server");
    expect(workspaceNameOf(workspaces, "BLOG")).toBe("BLOG");
    expect(workspaceNameOf(undefined, "API")).toBe("API");
  });
});

function q(id: number, issueId: string, askedAt: string): InboxQuestion {
  return {
    id,
    issueId,
    question: `質問 ${id}`,
    askedBy: "claude-code",
    askedAt,
    answer: null,
    answeredBy: null,
    answeredAt: null,
    issueTitle: `${issueId} のタイトル`,
    workspace: "API",
    branch: "main",
    worktree: "/repo",
  };
}

describe("groupInbox", () => {
  test("Issue ごとに1項目にまとめ、最後に質問が来た Issue を上にする", () => {
    const entries = groupInbox([
      q(1, "API-1", "2026-09-28T00:00:00.000Z"),
      q(2, "API-2", "2026-09-28T00:05:00.000Z"),
      q(3, "API-1", "2026-09-28T00:10:00.000Z"),
    ]);
    expect(entries.map((e) => e.issueId)).toEqual(["API-1", "API-2"]);
    expect(entries[0]?.questions.map((x) => x.id)).toEqual([1, 3]);
    expect(entries[0]?.latestAt).toBe("2026-09-28T00:10:00.000Z");
  });

  test("質問がなければ空", () => {
    expect(groupInbox([])).toEqual([]);
  });
});

describe("doingTaskTitle", () => {
  test("作業中の Task のタイトルを返し、なければ null", () => {
    const plan = (...statuses: Plan["tasks"][number]["status"][]): Plan => ({
      source: null,
      tasks: statuses.map((status, i) => ({ title: `Task ${i + 1}`, status, steps: [] })),
    });
    expect(doingTaskTitle(plan("done", "doing", "pending"))).toBe("Task 2");
    expect(doingTaskTitle(plan("done", "pending"))).toBeNull();
  });
});

describe("tomorrow", () => {
  test("地域の時刻で翌日の YYYY-MM-DD を返し、月末と年末を越える", () => {
    expect(tomorrow(new Date(2026, 8, 28, 23, 30))).toBe("2026-09-29");
    expect(tomorrow(new Date(2026, 8, 30, 9, 0))).toBe("2026-10-01");
    expect(tomorrow(new Date(2026, 11, 31, 0, 0))).toBe("2027-01-01");
  });
});
