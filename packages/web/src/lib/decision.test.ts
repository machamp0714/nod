import { describe, expect, test } from "bun:test";
import type { ActivityItem, InboxQuestion, Plan } from "../api/types";
import { doingTaskTitle, groupInbox, reviewReport, tomorrow, workspaceNameOf } from "./decision";

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

describe("reviewReport", () => {
  const comment = (at: string, actor: string, body: string): ActivityItem => ({ kind: "comment", id: 1, at, actor, body, replies: [], resolvedAt: null, resolvedBy: null });
  const toStatus = (at: string, from: string, to: string): ActivityItem => ({
    kind: "event",
    at,
    actor: "claude-code",
    type: "status_changed",
    data: { from, to },
  });

  test("最後に in_review に変わった時刻以前の、最も新しいコメントを報告とする", () => {
    const activity = [
      comment("2026-09-28T00:01:00.000Z", "claude-code", "途中の経過"),
      comment("2026-09-28T00:02:00.000Z", "claude-code", "署名を検証した"),
      toStatus("2026-09-28T00:02:00.001Z", "in_progress", "in_review"),
      comment("2026-09-28T00:03:00.000Z", "me", "見ておく"),
    ];
    expect(reviewReport(activity)).toEqual({ actor: "claude-code", at: "2026-09-28T00:02:00.000Z", body: "署名を検証した" });
  });

  test("差し戻しの後にやり直したら、新しい報告を取る", () => {
    const activity = [
      comment("2026-09-28T00:01:00.000Z", "claude-code", "1回目の報告"),
      toStatus("2026-09-28T00:01:00.001Z", "in_progress", "in_review"),
      comment("2026-09-28T00:02:00.000Z", "me", "テストが足りない"),
      toStatus("2026-09-28T00:02:00.001Z", "in_review", "in_progress"),
      comment("2026-09-28T00:03:00.000Z", "claude-code", "2回目の報告"),
      toStatus("2026-09-28T00:03:00.001Z", "in_progress", "in_review"),
    ];
    expect(reviewReport(activity)?.body).toBe("2回目の報告");
  });

  test("in_review に変わった記録がなければ null", () => {
    expect(reviewReport([comment("2026-09-28T00:01:00.000Z", "claude-code", "経過")])).toBeNull();
  });
});

describe("tomorrow", () => {
  test("地域の時刻で翌日の YYYY-MM-DD を返し、月末と年末を越える", () => {
    expect(tomorrow(new Date(2026, 8, 28, 23, 30))).toBe("2026-09-29");
    expect(tomorrow(new Date(2026, 8, 30, 9, 0))).toBe("2026-10-01");
    expect(tomorrow(new Date(2026, 11, 31, 0, 0))).toBe("2027-01-01");
  });
});
