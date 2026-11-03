import { describe, expect, test } from "bun:test";
import { atPoint, forgetListScroll, listIdentity, recallListScroll, rememberListScroll, scrollRegionKey } from "./list-scroll";

const key = { kind: "issues", target: "", identity: listIdentity({ q: "a", sort: "title" }) };

describe("recallListScroll", () => {
  test("同じ履歴エントリで、種類・対象・実効の条件がすべて同じときだけ返す", () => {
    rememberListScroll("entry-1", { ...key, regions: { main: { x: 0, y: 400 } } });
    expect(recallListScroll("entry-1", key)?.regions).toEqual({ main: { x: 0, y: 400 } });
    expect(recallListScroll("entry-2", key)).toBeNull();
    expect(recallListScroll("entry-1", { ...key, kind: "view" })).toBeNull();
    expect(recallListScroll("entry-1", { ...key, target: "1" })).toBeNull();
    expect(recallListScroll("entry-1", { ...key, identity: listIdentity({ q: "a", sort: "priority" }) })).toBeNull();
    forgetListScroll("entry-1");
    expect(recallListScroll("entry-1", key)).toBeNull();
  });

  test("覚える履歴エントリは上限を超えると古いものから捨てる", () => {
    for (let n = 0; n < 101; n++) rememberListScroll(`cap-${n}`, { ...key, regions: {} });
    expect(recallListScroll("cap-0", key)).toBeNull();
    expect(recallListScroll("cap-1", key)).not.toBeNull();
    expect(recallListScroll("cap-100", key)).not.toBeNull();
  });
});

describe("listIdentity", () => {
  test("キーの順と undefined の有無によらず同じ。配列の順と値の違いは区別する", () => {
    expect(listIdentity({ b: 1, a: [2, 1], c: undefined })).toBe(listIdentity({ a: [2, 1], b: 1 }));
    expect(listIdentity({ a: [1, 2] })).not.toBe(listIdentity({ a: [2, 1] }));
    expect(listIdentity({ layout: "board" })).not.toBe(listIdentity({ layout: "list" }));
  });
});

describe("scrollRegionKey", () => {
  test("グループとサブグループのキーで区別し、区切りの文字を含むキーも混同しない", () => {
    expect(scrollRegionKey("board")).toBe("board");
    expect(scrollRegionKey("table", ["a/b"])).not.toBe(scrollRegionKey("table", ["a", "b"]));
    expect(scrollRegionKey("table", ["API"])).not.toBe(scrollRegionKey("board", ["API"]));
  });
});

describe("atPoint", () => {
  test("小数の端数（1px 以内）は同じ位置とみなす", () => {
    expect(atPoint({ x: 0.5, y: 399.5 }, { x: 0, y: 400 })).toBe(true);
    expect(atPoint({ x: 0, y: 380 }, { x: 0, y: 400 })).toBe(false);
  });
});
