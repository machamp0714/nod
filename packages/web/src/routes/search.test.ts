import { describe, expect, test } from "bun:test";
import {
  cleanIssueListSearch,
  cleanProjectsSearch,
  parseIssueListSearch,
  parseProjectsSearch,
  parseSelectedSearch,
} from "./search";

describe("parseIssueListSearch", () => {
  test("正しい値はそのまま残す", () => {
    expect(parseIssueListSearch({ tab: "ready", layout: "board", q: "N+1" })).toEqual({ tab: "ready", layout: "board", q: "N+1" });
  });

  test("不正なタブと表示方法は既定値で上書きする", () => {
    expect(parseIssueListSearch({ tab: "foo", layout: "grid", q: "" })).toEqual({ tab: "all", layout: "list" });
    expect(parseIssueListSearch({ tab: 1, layout: null })).toEqual({ tab: "all", layout: "list" });
  });

  test("指定のないキーは追加しない", () => {
    expect(parseIssueListSearch({})).toEqual({});
    expect(parseIssueListSearch({ tab: "ready" })).toEqual({ tab: "ready" });
  });

  test("数字だけの検索語（ルーターが数値にしたもの）は文字列に戻す", () => {
    expect(parseIssueListSearch({ q: 128 })).toEqual({ q: "128" });
  });
});

describe("cleanIssueListSearch", () => {
  test("既定値のキーを除き、URL を短く保つ", () => {
    expect(cleanIssueListSearch({ tab: "all", layout: "list", q: "" })).toEqual({});
    expect(cleanIssueListSearch({ tab: "ready", layout: "list", q: "api" })).toEqual({ tab: "ready", q: "api" });
  });
});

describe("parseSelectedSearch と parseProjectsSearch", () => {
  test("selected は文字列だけを受け付ける", () => {
    expect(parseSelectedSearch({ selected: "API-8" })).toEqual({ selected: "API-8" });
    expect(parseSelectedSearch({ selected: 8 })).toEqual({});
  });

  test("Projects のタブは active、completed、all だけを受け付け、active は URL に残さない", () => {
    expect(parseProjectsSearch({ tab: "completed" })).toEqual({ tab: "completed" });
    expect(parseProjectsSearch({ tab: "zzz" })).toEqual({ tab: "active" });
    expect(parseProjectsSearch({ tab: 1 })).toEqual({ tab: "active" });
    expect(parseProjectsSearch({})).toEqual({});
    expect(cleanProjectsSearch({ tab: "active" })).toEqual({});
    expect(cleanProjectsSearch({ tab: "all" })).toEqual({ tab: "all" });
  });
});
