import { describe, expect, test } from "bun:test";
import { BOARD_STATUSES, priorityMeta, STATUS_META, STATUS_ORDER, statusLabel } from "./meta";

describe("ステータスの表示", () => {
  test("表示の順は spec のステータスの表のとおり", () => {
    expect(STATUS_ORDER).toEqual([
      "triage",
      "backlog",
      "needs_clarification",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "canceled",
    ]);
  });

  test("カンバンの列は Triage と Canceled を除いた6つ", () => {
    expect(BOARD_STATUSES).toEqual(["needs_clarification", "backlog", "todo", "in_progress", "in_review", "done"]);
  });

  test("ラベルは英語の表示ラベル", () => {
    expect(STATUS_ORDER.map((s) => STATUS_META[s].label)).toEqual([
      "Triage",
      "Backlog",
      "Needs Clarification",
      "Todo",
      "In Progress",
      "In Review",
      "Done",
      "Canceled",
    ]);
  });

  test("statusLabel は知らない値をそのまま返す", () => {
    expect(statusLabel("in_review")).toBe("In Review");
    expect(statusLabel("archived")).toBe("archived");
  });
});

describe("優先度の表示", () => {
  test("1 は Urgent、0 と範囲外は No priority", () => {
    expect(priorityMeta(1).label).toBe("Urgent");
    expect(priorityMeta(4).label).toBe("Low");
    expect(priorityMeta(0).label).toBe("No priority");
    expect(priorityMeta(9).label).toBe("No priority");
  });
});
