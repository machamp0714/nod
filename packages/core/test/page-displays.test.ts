import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { deletePageDisplay, listPageDisplays, setPageDisplay } from "../src/ops/page-displays";
import { validatePageDisplay } from "../src/page-display";
import { codeOf, setup, tempDbPath } from "./helpers";

describe("ページの表示設定", () => {
  test("ページごとに保存・上書き・削除でき、別のページには漏れない", () => {
    const { db } = setup();
    expect(listPageDisplays(db)).toEqual({});
    setPageDisplay(db, "issues", { layout: "board", groupBy: "project" });
    setPageDisplay(db, "project:1", { layout: "board" });
    setPageDisplay(db, "project:2", { sort: "priority", direction: "desc" });
    expect(listPageDisplays(db)).toEqual({
      issues: { layout: "board", groupBy: "project" },
      "project:1": { layout: "board" },
      "project:2": { sort: "priority", direction: "desc" },
    });
    expect(setPageDisplay(db, "issues", { layout: "list", showCompleted: false })).toEqual({ showCompleted: false });
    expect(listPageDisplays(db).issues).toEqual({ showCompleted: false });
    deletePageDisplay(db, "issues");
    deletePageDisplay(db, "issues"); // 2回目も失敗しない
    expect(Object.keys(listPageDisplays(db))).toEqual(["project:1", "project:2"]);
  });

  test("DB を開き直しても残る（サーバーの再起動）", () => {
    const path = tempDbPath();
    setPageDisplay(openDb(path), "my-issues", { groupBy: "none", columns: ["status"] });
    expect(listPageDisplays(openDb(path))).toEqual({ "my-issues": { groupBy: "none", columns: ["status"] } });
  });

  test("使えないページのキーは INVALID_ARGS", () => {
    const { db } = setup();
    for (const page of ["", "views", "view:1", "project:", "project:0", "project:abc", "cycle:-1", "issues "]) {
      expect(codeOf(() => setPageDisplay(db, page, {}))).toBe("INVALID_ARGS");
      expect(codeOf(() => deletePageDisplay(db, page))).toBe("INVALID_ARGS");
    }
  });

  test("削除した Cycle のキーも保存・読み出しでき、エラーにならない", () => {
    const { db } = setup();
    setPageDisplay(db, "cycle:999", { layout: "board" });
    expect(listPageDisplays(db)["cycle:999"]).toEqual({ layout: "board" });
  });
});

describe("validatePageDisplay", () => {
  test("View と同じく既定の値は省き、groupBy の none は残す（My Issues の既定は Status のため）", () => {
    expect(validatePageDisplay({ layout: "list", sort: "default", direction: "asc", showCompleted: true })).toEqual({});
    expect(validatePageDisplay({ groupBy: "none", subGroupBy: "status" })).toEqual({ groupBy: "none" });
    expect(validatePageDisplay({ groupBy: "project", subGroupBy: "status", columns: ["pr", "status"] })).toEqual({
      groupBy: "project",
      subGroupBy: "status",
      columns: ["status", "pr"],
    });
  });

  test("tab・知らないキー・不正な値は INVALID_ARGS", () => {
    expect(codeOf(() => validatePageDisplay({ tab: "ready" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => validatePageDisplay({ tab: "all" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => validatePageDisplay({ q: "x" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => validatePageDisplay({ layout: "grid" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => validatePageDisplay(null))).toBe("INVALID_ARGS");
    expect(codeOf(() => validatePageDisplay(undefined))).toBe("INVALID_ARGS");
  });
});
