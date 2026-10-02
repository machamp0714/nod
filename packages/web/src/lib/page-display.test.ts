import { describe, expect, test } from "bun:test";
import { DEFAULT_ISSUE_COLUMNS, defaultIssueColumns } from "../routes/search";
import { hasDisplayKey, pageDisplayFromSearch, pageSearch, withoutPageDisplay } from "./page-display";

describe("pageSearch", () => {
  test("URL にないキーは保存した値、URL に明示したキーは URL を使う。タブ・絞り込み・検索は URL のまま", () => {
    expect(pageSearch({ layout: "board", groupBy: "project", sort: "priority" }, { layout: "list", q: "x", tab: "ready", label: ["bug"] })).toEqual({
      layout: "list",
      groupBy: "project",
      sort: "priority",
      q: "x",
      tab: "ready",
      label: ["bug"],
    });
    expect(pageSearch({}, {})).toEqual({});
    expect(pageSearch({ columns: [] }, {})).toEqual({ columns: [] });
    expect(pageSearch({ showCompleted: false }, { showCompleted: true })).toEqual({ showCompleted: true });
  });
});

describe("pageDisplayFromSearch", () => {
  test("既定と違う表示設定だけを取り出し、タブ・絞り込み・検索・プレビューは含めない", () => {
    expect(
      pageDisplayFromSearch(
        { tab: "ready", layout: "board", groupBy: "project", subGroupBy: "status", sort: "title", direction: "desc", columns: ["status"], showCompleted: false, showChildren: false, q: "x", preview: "API-1", label: ["bug"], blocked: true },
        { key: "issues" },
      ),
    ).toEqual({ layout: "board", groupBy: "project", subGroupBy: "status", sort: "title", direction: "desc", columns: ["status"], showCompleted: false, showChildren: false });
    expect(pageDisplayFromSearch({ layout: "list", groupBy: "none", sort: "default", direction: "asc", columns: [...DEFAULT_ISSUE_COLUMNS] }, { key: "issues" })).toEqual({});
  });

  test("My Issues の「なし」は groupBy: none として残す（既定が Status のため）", () => {
    expect(pageDisplayFromSearch({ groupBy: "none" }, { key: "my-issues", mine: true })).toEqual({ groupBy: "none" });
    expect(pageDisplayFromSearch({}, { key: "my-issues", mine: true })).toEqual({});
  });

  test("Project 詳細の既定の列（Project を除く）は保存しない", () => {
    const scope = { key: "project:1", sameValueColumn: "project" } as const;
    expect(pageDisplayFromSearch({ columns: defaultIssueColumns("project"), sort: "priority" }, scope)).toEqual({ sort: "priority" });
    expect(pageDisplayFromSearch({ columns: [...DEFAULT_ISSUE_COLUMNS] }, scope)).toEqual({ columns: [...DEFAULT_ISSUE_COLUMNS] });
  });
});

describe("hasDisplayKey と withoutPageDisplay", () => {
  test("表示設定のキーがあるかを見る（値が undefined でもキーがあれば変更）", () => {
    expect(hasDisplayKey({ layout: "board" })).toBe(true);
    expect(hasDisplayKey({ subGroupBy: undefined })).toBe(true);
    expect(hasDisplayKey({ q: "x", tab: "ready", preview: "API-1" })).toBe(false);
  });

  test("表示設定のキーだけを消し、タブ・絞り込み・検索・プレビューは残す", () => {
    expect(withoutPageDisplay({ layout: "board", sort: "title", columns: [], tab: "ready", q: "x", preview: "API-1", label: ["bug"] })).toEqual({
      tab: "ready",
      q: "x",
      preview: "API-1",
      label: ["bug"],
    });
  });
});
