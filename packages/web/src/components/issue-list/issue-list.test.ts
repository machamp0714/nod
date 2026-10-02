import { describe, expect, test } from "bun:test";
import type { Issue, Status } from "../../api/types";
import { canDropOnStatus, countRows, filterRows, groupForBoard, groupRowsByWorkspace, sortRows } from "./issue-list";
import type { IssueListRow } from "./types";

function row(id: string, status: Status, opts: { priority?: number; ready?: boolean; title?: string; assignee?: string; estimate?: number | null; dueDate?: string | null } = {}): IssueListRow {
  return {
    issue: { id, title: opts.title ?? id, status, priority: opts.priority ?? 0, assignee: opts.assignee ?? null, estimate: opts.estimate ?? null, dueDate: opts.dueDate ?? null } as Issue,
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
    expect(countRows(rows)).toEqual({ all: 3, ready: 1, needsClarification: 1, delegated: 0, mine: 0 });
  });

  test("委任中タブは担当が LLM で done/canceled 以外の Issue だけを出し、件数を数える", () => {
    const delegated = [
      row("API-1", "in_progress", { assignee: "claude-code" }),
      row("API-2", "in_review", { assignee: "codex" }),
      row("API-3", "todo", { assignee: "me" }),
      row("API-4", "todo"),
      row("API-5", "done", { assignee: "codex" }),
      row("API-6", "canceled", { assignee: "codex" }),
    ];
    expect(ids(filterRows(delegated, { tab: "delegated", q: "" }))).toEqual(["API-1", "API-2"]);
    expect(countRows(delegated).delegated).toBe(2);
  });

  test("My issues の担当タブは担当が me か LLM の Issue を出し、未割り当ては出さない。完了済みは表示設定に従う", () => {
    const rows = [
      row("API-1", "in_progress", { assignee: "me" }),
      row("API-2", "todo", { assignee: "claude-code" }),
      row("API-3", "todo"),
      row("API-4", "done", { assignee: "me" }),
      row("API-5", "todo", { assignee: "ME" }),
    ];
    expect(ids(filterRows(rows, { tab: "mine", q: "" }))).toEqual(["API-1", "API-2", "API-4", "API-5"]);
    expect(ids(filterRows(rows, { tab: "mine", q: "", showCompleted: false }))).toEqual(["API-1", "API-2", "API-5"]);
    expect(ids(filterRows(rows, { tab: "mine", q: "api-4" }))).toEqual(["API-4"]);
    expect(countRows(rows)).toMatchObject({ mine: 4, delegated: 2 });
  });

  test("Triage と Backlog でも担当が LLM なら委任中に含める", () => {
    const rows = [
      row("API-1", "triage", { assignee: "claude-code" }),
      row("API-2", "backlog", { assignee: "codex" }),
      row("API-3", "triage"),
      row("API-4", "backlog", { assignee: "me" }),
    ];
    expect(ids(filterRows(rows, { tab: "delegated", q: "" }))).toEqual(["API-1", "API-2"]);
    expect(countRows(rows).delegated).toBe(2);
  });
});

describe("groupForBoard", () => {
  test("6つの列を順に作り、Triage と Canceled を出さず、空の列も残す", () => {
    const columns = groupForBoard([row("API-1", "triage"), row("API-2", "canceled"), row("API-3", "todo"), row("API-4", "todo")]);
    expect(columns.map((c) => c.status)).toEqual(["needs_clarification", "backlog", "todo", "in_progress", "in_review", "done"]);
    expect(columns.map((c) => c.rows.length)).toEqual([0, 0, 2, 0, 0, 0]);
  });
});


describe("表示設定による並び順", () => {
  const rows = [row("API-10", "done", { priority: 0, title: "同じ" }), row("API-2", "todo", { priority: 1, title: "同じ" }), row("API-3", "todo", { priority: 1, title: "あ" })];
  test("優先度なしは昇順の末尾、降順の先頭。同順位は常にID昇順", () => {
    expect(ids(sortRows(rows, "priority"))).toEqual(["API-2", "API-3", "API-10"]);
    expect(ids(sortRows(rows, "priority", "desc"))).toEqual(["API-10", "API-2", "API-3"]);
    expect(ids(rows)).toEqual(["API-10", "API-2", "API-3"]);
  });
  test("タイトルの昇降順でも同順位は安定する", () => {
    expect(ids(sortRows(rows, "title"))).toEqual(["API-3", "API-2", "API-10"]);
    expect(ids(sortRows(rows, "title", "desc"))).toEqual(["API-2", "API-10", "API-3"]);
  });
  for (const field of ["createdAt", "updatedAt"] as const) {
    test(`${field}は時差を含む日時を比較し同時刻はID順`, () => {
      const dated = rows.map((r, i) => ({ ...r, issue: { ...r.issue, [field]: ["2026-01-01T09:00:00+09:00", "2026-01-01T00:00:00Z", "2025-12-31T23:00:00Z"][i]! } }));
      expect(ids(sortRows(dated, field))).toEqual(["API-3", "API-2", "API-10"]);
      expect(ids(sortRows(dated, field, "desc"))).toEqual(["API-2", "API-10", "API-3"]);
    });
  }
  test("WorkspaceとBoardで選択済みの順を維持する", () => {
    const grouped = groupRowsByWorkspace(sortRows(rows.map((r) => ({ ...r, issue: { ...r.issue, workspace: "API", status: "todo" as const } })), "title"));
    expect(ids(grouped[0]!.rows)).toEqual(["API-3", "API-2", "API-10"]);
    expect(ids(groupForBoard(grouped[0]!.rows).find((c) => c.status === "todo")!.rows)).toEqual(["API-3", "API-2", "API-10"]);
  });
});

describe("見積もり・期限の並び順", () => {
  test("見積もりは数値順、未設定は昇順・降順とも末尾", () => {
    const rows = [row("API-1", "todo"), row("API-2", "todo", { estimate: 8 }), row("API-3", "todo", { estimate: 2 }), row("API-4", "todo")];
    expect(ids(sortRows(rows, "estimate"))).toEqual(["API-3", "API-2", "API-1", "API-4"]);
    expect(ids(sortRows(rows, "estimate", "desc"))).toEqual(["API-2", "API-3", "API-1", "API-4"]);
  });
  test("期限は日付順、未設定は昇順・降順とも末尾", () => {
    const rows = [row("API-1", "todo"), row("API-2", "todo", { dueDate: "2026-12-01" }), row("API-3", "todo", { dueDate: "2026-10-01" })];
    expect(ids(sortRows(rows, "dueDate"))).toEqual(["API-3", "API-2", "API-1"]);
    expect(ids(sortRows(rows, "dueDate", "desc"))).toEqual(["API-2", "API-3", "API-1"]);
  });
});

describe("canDropOnStatus", () => {
  test("元と同じ列と Needs Clarification の列には落とせない", () => {
    expect(canDropOnStatus("todo", "todo")).toBe(false);
    expect(canDropOnStatus("todo", "needs_clarification")).toBe(false);
    expect(canDropOnStatus("needs_clarification", "needs_clarification")).toBe(false);
  });

  test("ほかの列には落とせる（Needs Clarification から出すのも可）", () => {
    expect(canDropOnStatus("todo", "in_progress")).toBe(true);
    expect(canDropOnStatus("backlog", "done")).toBe(true);
    expect(canDropOnStatus("needs_clarification", "todo")).toBe(true);
  });
});
