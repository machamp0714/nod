import { describe, expect, test } from "bun:test";
import { bulkFailures, labelMenu, pruneSelection, selectAllState, toggleAll, toggleSelection } from "./bulk-selection";

const order = ["A-1", "A-2", "A-3", "A-4", "A-5"];

describe("toggleSelection", () => {
  test("クリックで1件を切り替え、起点を更新する", () => {
    const one = toggleSelection({ ids: new Set(), anchor: null }, order, "A-2", false);
    expect([...one.ids]).toEqual(["A-2"]);
    expect(one.anchor).toBe("A-2");
    const off = toggleSelection(one, order, "A-2", false);
    expect([...off.ids]).toEqual([]);
  });

  test("Shift で起点からの表示順の範囲を、起点と同じ状態にそろえる", () => {
    const start = toggleSelection({ ids: new Set(), anchor: null }, order, "A-4", false);
    const range = toggleSelection(start, order, "A-2", true);
    expect([...range.ids].sort()).toEqual(["A-2", "A-3", "A-4"]);
    // 起点が外れているときの Shift は範囲を外す
    const cleared = toggleSelection({ ids: new Set(order), anchor: "A-1" }, order, "A-1", false);
    const unrange = toggleSelection(cleared, order, "A-3", true);
    expect([...unrange.ids].sort()).toEqual(["A-4", "A-5"]);
  });

  test("起点が表示にないときの Shift は1件の切り替えになる", () => {
    const r = toggleSelection({ ids: new Set(), anchor: "Z-9" }, order, "A-3", true);
    expect([...r.ids]).toEqual(["A-3"]);
  });
});

describe("全選択", () => {
  test("表示中の全件・一部・なしを区別する", () => {
    expect(selectAllState(new Set(), order)).toBe("none");
    expect(selectAllState(new Set(["A-1"]), order)).toBe("some");
    expect(selectAllState(new Set(order), order)).toBe("all");
    expect(selectAllState(new Set(), [])).toBe("none");
  });

  test("全件選択中なら表示中を外し、そうでなければ表示中をすべて選ぶ（表示外の選択は残す）", () => {
    expect([...toggleAll(new Set(["X-1", "A-1"]), order)].sort()).toEqual([...order, "X-1"].sort());
    expect([...toggleAll(new Set([...order, "X-1"]), order)]).toEqual(["X-1"]);
  });
});

test("pruneSelection は一覧から消えた Issue を選択から外す（同じなら同じ Set を返す）", () => {
  const ids = new Set(["A-1", "Z-9"]);
  expect([...pruneSelection(ids, order)]).toEqual(["A-1"]);
  const same = new Set(["A-1"]);
  expect(pruneSelection(same, order)).toBe(same);
});

test("bulkFailures は BULK_UPDATE_FAILED の details から失敗一覧を取り出す", () => {
  const failures = [{ id: "A-1", code: "NOT_FOUND", message: "ない" }];
  expect(bulkFailures({ code: "BULK_UPDATE_FAILED", details: { failures } })).toEqual(failures);
  expect(bulkFailures({ code: "BULK_UPDATE_FAILED", details: { failures: "x" } })).toEqual([]);
  expect(bulkFailures(new Error("x"))).toEqual([]);
});

describe("labelMenu", () => {
  const selected = [{ labels: ["perf", "security"] }, { labels: ["perf"] }, { labels: ["security"] }];
  test("追加は全件に付いているラベルを除き、削除は1件以上に付いているラベルと件数を出す", () => {
    const menu = labelMenu(selected, ["bug", "docs", "perf", "security"], "");
    expect(menu.add).toEqual(["bug", "docs", "perf", "security"]);
    expect(labelMenu([{ labels: ["perf"] }, { labels: ["perf"] }], ["bug", "perf"], "").add).toEqual(["bug"]);
    expect(menu.create).toBeNull();
    expect(menu.remove).toEqual([{ label: "perf", count: 2 }, { label: "security", count: 2 }]);
  });

  test("検索語で絞り込み、どこにもないラベルは新規に追加できる", () => {
    expect(labelMenu(selected, ["bug", "docs"], "do")).toEqual({ add: ["docs"], create: "do", remove: [] });
    expect(labelMenu(selected, ["bug"], " bug ").create).toBeNull();
    expect(labelMenu(selected, [], "a b").create).toBeNull();
    expect(labelMenu(selected, [], "a,b").create).toBeNull();
    expect(labelMenu(selected, ["bug"], "perf")).toEqual({ add: ["perf"], create: null, remove: [{ label: "perf", count: 2 }] });
  });
});
