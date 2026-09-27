import { describe, expect, test } from "bun:test";
import type { Issue, Status } from "../../api/types";
import { countRows, filterRows, groupForBoard, sortRows } from "./issue-list";
import type { IssueListRow } from "./types";

function row(id: string, status: Status, opts: { priority?: number; ready?: boolean; title?: string } = {}): IssueListRow {
  return {
    issue: { id, title: opts.title ?? id, status, priority: opts.priority ?? 0 } as Issue,
    questions: { decided: 0, total: 0 },
    ready: opts.ready ?? false,
    workspaceName: "api-server",
  };
}

const ids = (rows: IssueListRow[]) => rows.map((r) => r.issue.id);

describe("sortRows", () => {
  test("ステータスの表示順、優先度、ID の番号の順に並べる", () => {
    const rows = [
      row("API-12", "todo", { priority: 0 }),
      row("API-4", "todo", { priority: 0 }),
      row("API-7", "todo", { priority: 1 }),
      row("API-1", "done"),
      row("API-2", "triage"),
    ];
    expect(ids(sortRows(rows))).toEqual(["API-2", "API-7", "API-4", "API-12", "API-1"]);
  });
});

describe("filterRows", () => {
  const rows = [
    row("API-1", "todo", { ready: true, title: "検索を速くする" }),
    row("API-2", "needs_clarification", { title: "既定値を決める" }),
    row("NOD-3", "in_progress", { title: "Sidebar" }),
  ];

  test("タブで絞り込む", () => {
    expect(ids(filterRows(rows, { tab: "all", q: "" }))).toEqual(["API-1", "API-2", "NOD-3"]);
    expect(ids(filterRows(rows, { tab: "ready", q: "" }))).toEqual(["API-1"]);
    expect(ids(filterRows(rows, { tab: "needs_clarification", q: "" }))).toEqual(["API-2"]);
  });

  test("検索語はタイトルと ID に、大文字小文字を区別せずに当てる", () => {
    expect(ids(filterRows(rows, { tab: "all", q: "nod-3" }))).toEqual(["NOD-3"]);
    expect(ids(filterRows(rows, { tab: "all", q: " 既定値 " }))).toEqual(["API-2"]);
    expect(ids(filterRows(rows, { tab: "ready", q: "既定値" }))).toEqual([]);
  });

  test("件数を数える", () => {
    expect(countRows(rows)).toEqual({ all: 3, ready: 1, needsClarification: 1 });
  });
});

describe("groupForBoard", () => {
  test("6つの列を順に作り、Triage と Canceled を出さず、空の列も残す", () => {
    const columns = groupForBoard([row("API-1", "triage"), row("API-2", "canceled"), row("API-3", "todo"), row("API-4", "todo")]);
    expect(columns.map((c) => c.status)).toEqual(["needs_clarification", "backlog", "todo", "in_progress", "in_review", "done"]);
    expect(columns.map((c) => c.rows.length)).toEqual([0, 0, 2, 0, 0, 0]);
  });
});
