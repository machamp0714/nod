import { describe, expect, test } from "bun:test";
import { bulkFailures, cycleMenu, labelMenu, milestoneMenu, pruneSelection, selectAllState, toggleAll, toggleSelection } from "./bulk-selection";

const order = ["A-1", "A-2", "A-3", "A-4", "A-5"];

const at = (id: string) => order.indexOf(id);

describe("toggleSelection", () => {
  test("クリックで1件を切り替え、起点を更新する", () => {
    const one = toggleSelection({ ids: new Set(), anchor: null }, order, at("A-2"), false);
    expect([...one.ids]).toEqual(["A-2"]);
    expect(one.anchor).toEqual({ id: "A-2", at: 1 });
    const off = toggleSelection(one, order, at("A-2"), false);
    expect([...off.ids]).toEqual([]);
  });

  test("Shift で起点からの表示順の範囲を、起点と同じ状態にそろえる", () => {
    const start = toggleSelection({ ids: new Set(), anchor: null }, order, at("A-4"), false);
    const range = toggleSelection(start, order, at("A-2"), true);
    expect([...range.ids].sort()).toEqual(["A-2", "A-3", "A-4"]);
    // 起点が外れているときの Shift は範囲を外す
    const cleared = toggleSelection({ ids: new Set(order), anchor: { id: "A-1", at: 0 } }, order, at("A-1"), false);
    const unrange = toggleSelection(cleared, order, at("A-3"), true);
    expect([...unrange.ids].sort()).toEqual(["A-4", "A-5"]);
  });

  test("起点が表示にないときの Shift は1件の切り替えになる", () => {
    const r = toggleSelection({ ids: new Set(), anchor: { id: "Z-9", at: 9 } }, order, at("A-3"), true);
    expect([...r.ids]).toEqual(["A-3"]);
  });

  test("同じ Issue が何度も出る表示（ラベルのグループ）では、クリックした位置を起点・終点にする（#121）", () => {
    // perf: A-1 A-2 / security: A-3 A-1 A-4
    const positions = ["A-1", "A-2", "A-3", "A-1", "A-4"];
    const start = toggleSelection({ ids: new Set(), anchor: null }, positions, 3, false); // security の A-1
    const range = toggleSelection(start, positions, 4, true);
    expect([...range.ids].sort()).toEqual(["A-1", "A-4"]);
    const back = toggleSelection({ ids: new Set(), anchor: null }, positions, 2, false);
    expect([...toggleSelection(back, positions, 3, true).ids].sort()).toEqual(["A-1", "A-3"]);
  });

  test("起点の位置が一覧の更新でずれたら、その Issue の最初の位置を起点にする", () => {
    const r = toggleSelection({ ids: new Set(["A-2"]), anchor: { id: "A-2", at: 4 } }, order, at("A-3"), true);
    expect([...r.ids].sort()).toEqual(["A-2", "A-3"]);
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

describe("cycleMenu・milestoneMenu（#154）", () => {
  test("cycleMenu は Workspace が混ざっていても、終了していない Cycle を current 先頭・開始日順で返す", () => {
    const c = (id: number, state: "current" | "upcoming" | "completed", startDate: string) => ({ id, name: `S${id}`, state, startDate });
    expect(cycleMenu([c(1, "completed", "2026-09-01"), c(3, "upcoming", "2026-10-19"), c(2, "current", "2026-10-05")]).map((x) => x.id)).toEqual([2, 3]);
  });

  const ms = (id: number, projectId: number) => ({ id, projectId, name: `M${id}` });
  const milestones = [ms(1, 10), ms(2, 20), ms(3, 10)];
  const p = (id: number) => ({ project: { id, name: `P${id}` } });

  test("選択の Project が1つなら、その Project の名前と Milestone を出す", () => {
    expect(milestoneMenu([p(10), p(10)], milestones)).toEqual({ project: { id: 10, name: "P10" }, milestones: [milestones[0]!, milestones[2]!] });
  });

  test("Project が混ざる・Project のない Issue があると理由つきで無効にする", () => {
    expect(milestoneMenu([p(10), p(20)], milestones)).toEqual({ disabled: "選択に複数の Project が混在しているため、Milestone は一括変更できません" });
    expect(milestoneMenu([p(10), { project: null }], milestones)).toEqual({ disabled: "Project のない Issue が含まれるため、Milestone は一括変更できません" });
  });
});
