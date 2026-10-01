import { describe, expect, test } from "bun:test";
import type { ViewDisplay } from "../api/types";
import { DEFAULT_ISSUE_COLUMNS, defaultGroupBy, type IssueListSearch, parseIssueListSearch } from "../routes/search";
import { cleanViewSearch, describeDisplay, displayFromSearch, displaySummary, sameDisplay, savedDisplay, unsavedNote, viewSearch, withoutDisplay } from "./view-display";

describe("displayFromSearch", () => {
  test("既定と違う表示設定だけを取り出し、絞り込み・検索・プレビューは含めない", () => {
    expect(
      displayFromSearch({
        tab: "ready",
        groupBy: "project",
        subGroupBy: "status",
        sort: "priority",
        direction: "desc",
        layout: "board",
        columns: ["status", "pr"],
        showCompleted: false,
        showChildren: false,
        label: ["scope: docs"],
        q: "foo",
        preview: "NOD-1",
      }),
    ).toEqual({ tab: "ready", layout: "board", groupBy: "project", subGroupBy: "status", sort: "priority", direction: "desc", columns: ["status", "pr"], showCompleted: false, showChildren: false });
    expect(displayFromSearch({ tab: "all", layout: "list", sort: "default", direction: "asc", groupBy: "none", columns: [...DEFAULT_ISSUE_COLUMNS], showCompleted: true })).toEqual({});
    expect(displayFromSearch({ subGroupBy: "status" })).toEqual({});
  });

  test("委任中タブは保存せず（filter の delegated で持つ）、そのタブの既定のグループ化（担当）を保存する", () => {
    expect(displayFromSearch({ tab: "delegated" })).toEqual({ groupBy: "assignee" });
    expect(displayFromSearch({ tab: "delegated", groupBy: "none" })).toEqual({});
    expect(displayFromSearch({ tab: "delegated", groupBy: "project" })).toEqual({ groupBy: "project" });
  });
});

describe("viewSearch", () => {
  const display: ViewDisplay = { tab: "ready", groupBy: "project", subGroupBy: "status", sort: "priority", direction: "desc", layout: "board", columns: ["status"], showCompleted: false };

  test("URL に表示設定がなければ View の表示設定で表示する", () => {
    expect(viewSearch(display, {})).toEqual({ tab: "ready", groupBy: "project", subGroupBy: "status", sort: "priority", direction: "desc", layout: "board", columns: ["status"], showCompleted: false });
    expect(viewSearch({}, {})).toEqual({});
    expect(viewSearch(display, { q: "foo", preview: "NOD-1" })).toMatchObject({ tab: "ready", q: "foo", preview: "NOD-1" });
  });

  test("URL に明示したキーは URL を優先し、既定の値も明示できる", () => {
    const url = parseIssueListSearch({ tab: "all", groupBy: "none", sort: "default", direction: "asc", layout: "list", columns: [...DEFAULT_ISSUE_COLUMNS], showCompleted: true });
    expect(viewSearch(display, url)).toEqual({});
    expect(viewSearch(display, { sort: "title" })).toMatchObject({ sort: "title", direction: "desc", groupBy: "project" });
    expect(viewSearch({}, { groupBy: "status", sort: "title" })).toEqual({ groupBy: "status", sort: "title" });
  });

  test("URL の subGroupBy が表示中の groupBy と同じなら、サブグループなしを表す", () => {
    expect(viewSearch(display, { subGroupBy: "project" })).not.toHaveProperty("subGroupBy");
    expect(viewSearch(display, { groupBy: "workspace" })).toMatchObject({ groupBy: "workspace", subGroupBy: "status" });
  });
});

describe("cleanViewSearch", () => {
  const display: ViewDisplay = { tab: "ready", groupBy: "project", subGroupBy: "status", sort: "priority", direction: "desc", layout: "board", columns: ["status"], showCompleted: false, showChildren: false };

  test("View の表示設定と同じ値は URL に書かず、違う値だけを書く", () => {
    expect(cleanViewSearch(viewSearch(display, {}), display)).toEqual({});
    expect(cleanViewSearch({ ...viewSearch(display, {}), sort: "title", q: "foo", workspace: ["API"] }, display)).toEqual({ sort: "title", q: "foo", workspace: ["API"] });
    expect(cleanViewSearch({ groupBy: "status" }, {})).toEqual({ groupBy: "status" });
    expect(cleanViewSearch({ tab: "all", sort: "default" }, {})).toEqual({});
  });

  test("View の表示設定を既定に戻したときは、既定の値を URL に明示する", () => {
    expect(cleanViewSearch({}, display)).toEqual({
      tab: "all",
      groupBy: "none",
      sort: "default",
      direction: "asc",
      layout: "list",
      columns: [...DEFAULT_ISSUE_COLUMNS],
      showCompleted: true,
      showChildren: true,
    });
    expect(cleanViewSearch({ ...viewSearch(display, {}), subGroupBy: undefined }, display)).toEqual({ subGroupBy: "project" });
  });

  test("書いた URL を読み直すと、同じ表示に戻る", () => {
    const displays: ViewDisplay[] = [{}, display, { groupBy: "project", subGroupBy: "status" }, { tab: "needs_clarification", columns: [] }];
    const searches: IssueListSearch[] = [
      {},
      { tab: "ready" },
      { tab: "delegated" },
      { tab: "delegated", groupBy: "none" },
      { groupBy: "status" },
      { groupBy: "project" },
      { groupBy: "project", subGroupBy: "label" },
      { groupBy: "workspace", subGroupBy: "status" },
      { sort: "dueDate", direction: "desc" },
      { layout: "board", showCompleted: false },
      { columns: ["priority", "status", "dueDate"] },
      { columns: [] },
      { showChildren: false, q: "x", preview: "API-1", label: ["bug"] },
    ];
    for (const d of displays) {
      for (const search of searches) {
        const url = parseIssueListSearch({ ...cleanViewSearch(search, d) });
        // 委任中タブの既定のグループ化（担当）は、URL に明示されることがあるため解決してから比べる
        const resolved = (x: IssueListSearch) => ({ ...x, groupBy: x.groupBy ?? defaultGroupBy(x.tab) });
        expect(resolved(viewSearch(d, url))).toEqual(resolved(viewSearch({}, search)));
      }
    }
  });
});

describe("sameDisplay・withoutDisplay", () => {
  test("キーの順を問わずに比べる", () => {
    expect(sameDisplay({ sort: "priority", groupBy: "project" }, { groupBy: "project", sort: "priority" })).toBe(true);
    expect(sameDisplay({ sort: "priority" }, {})).toBe(false);
    expect(sameDisplay({ columns: [] }, {})).toBe(false);
  });

  test("API で保存した既定と同じ列（順だけ違うものも）は、変更として扱わない", () => {
    const display = { groupBy: "project", columns: ["assignee", "project", "workspace", "status", "priority"] } as const;
    expect(savedDisplay({ ...display, columns: [...display.columns] })).toEqual({ groupBy: "project" });
    expect(sameDisplay(displayFromSearch(viewSearch({ ...display, columns: [...display.columns] }, {})), savedDisplay({ ...display, columns: [...display.columns] }))).toBe(true);
    // 既定と違う列と、列以外の表示設定はそのまま
    expect(savedDisplay({ tab: "ready", columns: ["status"], showChildren: false })).toEqual({ tab: "ready", columns: ["status"], showChildren: false });
    expect(savedDisplay({ columns: [] })).toEqual({ columns: [] });
    // #196 より前の既定（未決事項・PR を含む7列）を明示して保存した View は、その列のまま出す
    const before = { columns: ["priority", "status", "questions", "workspace", "project", "assignee", "pr"] } satisfies ViewDisplay;
    expect(savedDisplay(before)).toEqual(before);
    expect(viewSearch(before, {}).columns).toEqual(before.columns);
  });

  test("表示設定のキーだけを URL から外す", () => {
    expect(withoutDisplay({ tab: "ready", groupBy: "none", subGroupBy: "status", sort: "title", direction: "desc", layout: "board", columns: [], showCompleted: false, showChildren: false, q: "x", preview: "API-1" })).toEqual({ q: "x", preview: "API-1" });
  });
});

describe("保存ダイアログに出す内容", () => {
  test("保存する表示設定を、既定と違うものだけ並べる", () => {
    expect(describeDisplay({})).toEqual([]);
    expect(describeDisplay({ tab: "ready", layout: "board", groupBy: "project", subGroupBy: "status", sort: "priority", direction: "desc", columns: ["status", "pr"], showCompleted: false, showChildren: false })).toEqual([
      { name: "タブ", value: "Ready" },
      { name: "表示", value: "ボード" },
      { name: "グループ", value: "Project" },
      { name: "サブグループ", value: "Status" },
      { name: "並び", value: "優先度（降順）" },
      { name: "列", value: "Status, PR" },
      { name: "完了済み Issue", value: "非表示" },
      { name: "子 Issue", value: "非表示" },
    ]);
    expect(describeDisplay({ tab: "needs_clarification", sort: "title", columns: [] })).toEqual([
      { name: "タブ", value: "Needs Clarification" },
      { name: "並び", value: "タイトル（昇順）" },
      { name: "列", value: "ID・タイトル・更新日時のみ" },
    ]);
    expect(describeDisplay({ direction: "desc" })).toEqual([{ name: "並び", value: "既定（降順）" }]);
  });

  test("表示の要約は「 ／ 」で区切り、全角の閉じ括弧の直後は前の空白を置かない", () => {
    expect(displaySummary(describeDisplay({ tab: "ready", groupBy: "project", sort: "priority", layout: "board" }))).toBe("タブ Ready ／ 表示 ボード ／ グループ Project ／ 並び 優先度（昇順）");
    expect(displaySummary(describeDisplay({ sort: "priority", showChildren: false }))).toBe("並び 優先度（昇順）／ 子 Issue 非表示");
    expect(displaySummary([])).toBe("");
  });

  test("保存しないもの（検索欄の入力とプレビュー）があるときだけ注記を返す", () => {
    expect(unsavedNote({})).toBeNull();
    expect(unsavedNote({ tab: "ready", groupBy: "project" })).toBeNull();
    expect(unsavedNote({ q: "foo" })).toBe("検索欄の入力「foo」は保存しません");
    expect(unsavedNote({ preview: "API-1" })).toBe("プレビューは保存しません");
    expect(unsavedNote({ q: "foo", preview: "API-1" })).toBe("検索欄の入力「foo」とプレビューは保存しません");
  });
});
