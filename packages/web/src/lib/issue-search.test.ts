import { describe, expect, test } from "bun:test";
import { isIssueSearchShortcut, matchIssueSearch } from "./issue-search";

const key = (init: Partial<{ key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }>) => ({
  key: "f",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...init,
});

describe("isIssueSearchShortcut", () => {
  test("Shift + Cmd + F と Shift + Ctrl + F で開く", () => {
    expect(isIssueSearchShortcut(key({ key: "F", shiftKey: true, metaKey: true }))).toBe(true);
    expect(isIssueSearchShortcut(key({ key: "f", shiftKey: true, metaKey: true }))).toBe(true);
    expect(isIssueSearchShortcut(key({ key: "F", shiftKey: true, ctrlKey: true }))).toBe(true);
  });

  test("Shift がない、Cmd も Ctrl もない、Alt を足した、別のキーのときは開かない", () => {
    expect(isIssueSearchShortcut(key({ metaKey: true }))).toBe(false);
    expect(isIssueSearchShortcut(key({ key: "F", shiftKey: true }))).toBe(false);
    expect(isIssueSearchShortcut(key({ key: "F", shiftKey: true, metaKey: true, altKey: true }))).toBe(false);
    expect(isIssueSearchShortcut(key({ key: "G", shiftKey: true, metaKey: true }))).toBe(false);
  });
});

describe("matchIssueSearch", () => {
  const issues = [
    { id: "NOD-1", title: "表示設定を保存する", description: "検索の話は書かない" },
    { id: "NOD-12", title: "Search dialog", description: null },
    { id: "API-3", title: "検索 API を速くする", description: null },
  ];

  test("ID とタイトルに大文字小文字を問わず部分一致するものだけを返し、説明だけの一致は除く", () => {
    expect(matchIssueSearch(issues, "検索").map((i) => i.id)).toEqual(["API-3"]);
    expect(matchIssueSearch(issues, "search").map((i) => i.id)).toEqual(["NOD-12"]);
    expect(matchIssueSearch(issues, "nod-1").map((i) => i.id)).toEqual(["NOD-1", "NOD-12"]);
  });

  test("前後の空白は無視し、空のキーワードでは何も返さない", () => {
    expect(matchIssueSearch(issues, "  api-3 ").map((i) => i.id)).toEqual(["API-3"]);
    expect(matchIssueSearch(issues, "   ")).toEqual([]);
  });

  test("ID が完全に一致するものを先頭に置き、上限で切っても残す", () => {
    const many = [
      { id: "API-12", title: "a" },
      { id: "API-112", title: "b" },
      { id: "NOD-12", title: "c" },
      { id: "NOD-120", title: "d" },
    ];
    expect(matchIssueSearch(many, "nod-12").map((i) => i.id)).toEqual(["NOD-12", "NOD-120"]);
    expect(matchIssueSearch(many, "API-112").map((i) => i.id)).toEqual(["API-112"]);
    expect(matchIssueSearch([...many].reverse(), "nod-12", 1).map((i) => i.id)).toEqual(["NOD-12"]);
  });

  test("件数の上限で切る", () => {
    expect(matchIssueSearch(issues, "-", 2).map((i) => i.id)).toEqual(["NOD-1", "NOD-12"]);
  });
});
