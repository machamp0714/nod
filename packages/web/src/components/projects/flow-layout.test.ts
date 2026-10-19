import { describe, expect, test } from "bun:test";
import type { ProjectFlow, ProjectFlowNode } from "../../api/types";
import { CARD_HEIGHT, CARD_WIDTH, COLUMN_GAP, cardHeight, flowNodeState, layoutFlow, ROW_GAP, TRUNK_SPACING } from "./flow-layout";

function node(id: string, extra: Partial<ProjectFlowNode> = {}): ProjectFlowNode {
  return {
    id,
    title: `title ${id}`,
    status: "todo",
    workspace: "API",
    workspaceName: "api-server",
    project: { id: 1, name: "P" },
    external: false,
    ready: true,
    openBlockers: [],
    ...extra,
  };
}

function flow(ids: string[], edges: [string, string][], extra: Record<string, Partial<ProjectFlowNode>> = {}): ProjectFlow {
  return { projectId: 1, nodes: ids.map((id) => node(id, extra[id])), edges: edges.map(([from, to]) => ({ from, to })) };
}

// 段（左からの列）ごとの ID。列の中は上から
function columns(layout: ReturnType<typeof layoutFlow>): string[][] {
  const xs = [...new Set(layout.cards.map((c) => c.x))].sort((a, b) => a - b);
  return xs.map((x) => layout.cards.filter((c) => c.x === x).sort((a, b) => a.y - b.y).map((c) => c.node.id));
}

describe("layoutFlow", () => {
  test("前提から後続へ、左から右の列に並べる", () => {
    const layout = layoutFlow(flow(["A-1", "A-2", "A-3"], [["A-2", "A-3"], ["A-1", "A-2"]]));
    expect(columns(layout)).toEqual([["A-1"], ["A-2"], ["A-3"]]);
    expect(layout.independent).toEqual([]);
    expect(layout.cycle).toEqual([]);
  });

  test("分岐は同じ列に縦に、合流は複数の矢印で1つのカードへ（R4bvo の形）", () => {
    const layout = layoutFlow(flow(
      ["A-1", "A-2", "A-3", "A-4", "A-5"],
      [["A-1", "A-2"], ["A-2", "A-3"], ["A-2", "A-4"], ["A-3", "A-5"], ["A-4", "A-5"]],
    ));
    expect(columns(layout)).toEqual([["A-1"], ["A-2"], ["A-3", "A-4"], ["A-5"]]);
    expect(layout.edges.filter((e) => e.to === "A-5").map((e) => e.from)).toEqual(["A-3", "A-4"]);
    expect(layout.predecessors.get("A-5")).toEqual(["A-3", "A-4"]);
    // 列を横に、カードどうしは重ならない
    expect(layout.width).toBe(4 * CARD_WIDTH + 3 * COLUMN_GAP);
    expect(layout.height).toBe(2 * cardHeight(node("A-3"), true) + ROW_GAP);
  });

  test("矢印は前提の右端の中央から後続の左端の中央へ、縦横の線でつなぐ", () => {
    const layout = layoutFlow(flow(["A-1", "A-2", "A-3"], [["A-1", "A-2"], ["A-1", "A-3"]]));
    const card = (id: string) => layout.cards.find((c) => c.node.id === id)!;
    for (const edge of layout.edges) {
      const from = card(edge.from);
      const to = card(edge.to);
      expect(edge.points[0]).toEqual({ x: from.x + CARD_WIDTH, y: from.y + from.height / 2 });
      expect(edge.points.at(-1)).toEqual({ x: to.x, y: to.y + to.height / 2 });
      edge.points.slice(1).forEach((p, i) => {
        const q = edge.points[i]!;
        expect(p.x === q.x || p.y === q.y).toBe(true);
      });
    }
  });

  test("前提の違う矢印は列の間で別の縦線を通り、同じ前提の分岐だけが縦線を共有する", () => {
    // e2e の seedBranchAndMerge と同じ形。FL-1 → FL-2・FL-3・FL-8、FL-2・FL-3 → FL-4、Project 外の OUT-1 → FL-4（列をまたぐ）
    const layout = layoutFlow(flow(
      ["FL-1", "FL-2", "FL-3", "FL-4", "FL-8", "OUT-1"],
      [["FL-1", "FL-2"], ["FL-1", "FL-3"], ["FL-1", "FL-8"], ["FL-2", "FL-4"], ["FL-3", "FL-4"], ["OUT-1", "FL-4"]],
      { "OUT-1": { external: true } },
    ));
    expect(columns(layout)).toEqual([["FL-1", "OUT-1"], ["FL-2", "FL-3", "FL-8"], ["FL-4"]]);
    // 縦の線分を x ごとに集めると、どの x も1つの前提だけが使う
    const fromsByX = new Map<number, Set<string>>();
    for (const edge of layout.edges) {
      edge.points.slice(1).forEach((p, i) => {
        const q = edge.points[i]!;
        if (p.x !== q.x || p.y === q.y) return;
        fromsByX.set(p.x, (fromsByX.get(p.x) ?? new Set()).add(edge.from));
      });
    }
    for (const [x, froms] of fromsByX) expect([x, [...froms]]).toEqual([x, [...froms].slice(0, 1)]);
    // FL-1 の分岐は1本の縦線を共有する
    const trunk = (edge: (typeof layout.edges)[number]) => edge.points.find((p, i) => i > 0 && p.x === edge.points[i - 1]!.x)?.x;
    const fromFl1 = layout.edges.filter((e) => e.from === "FL-1").map(trunk).filter((x) => x !== undefined);
    expect(new Set(fromFl1).size).toBe(1);
    // 縦線は列の間に収まり、カードに重ならない
    for (const x of fromsByX.keys()) {
      for (const card of layout.cards) expect(x > card.x && x < card.x + CARD_WIDTH).toBe(false);
    }
  });

  test("列の間を通る前提が多いと、縦線の間隔を保つよう列の間を広げる", () => {
    const sources = Array.from({ length: 6 }, (_, i) => `A-${i + 1}`);
    const layout = layoutFlow(flow([...sources, "B-1"], sources.map((id) => [id, "B-1"])));
    const target = layout.cards.find((c) => c.node.id === "B-1")!;
    expect(target.x - CARD_WIDTH).toBe(7 * TRUNK_SPACING);
    const xs = [...new Set(layout.edges.map((e) => e.points[1]!.x))].sort((a, b) => a - b);
    expect(xs).toHaveLength(6);
    xs.slice(1).forEach((x, i) => expect(x - xs[i]!).toBeGreaterThanOrEqual(TRUNK_SPACING));
  });

  test("カードの高さは前提・Project 外の行の有無で決まる", () => {
    const layout = layoutFlow(flow(["A-1", "A-2", "B-1"], [["A-1", "A-2"], ["B-1", "A-2"]], { "B-1": { external: true } }));
    const height = (id: string) => layout.cards.find((c) => c.node.id === id)!.height;
    expect(height("A-1")).toBe(CARD_HEIGHT);
    expect(height("A-2")).toBe(cardHeight(node("A-2"), true));
    expect(height("B-1")).toBe(cardHeight(node("B-1", { external: true }), false));
    expect(cardHeight(node("A-2"), true)).toBeGreaterThan(CARD_HEIGHT);
    expect(cardHeight(node("B-1", { external: true }), true)).toBe(CARD_HEIGHT + 2 * (cardHeight(node("A-2"), true) - CARD_HEIGHT));
  });

  test("依存辺のない主対象は別枠に出し、段には並べない", () => {
    const layout = layoutFlow(flow(["A-1", "A-2", "A-3"], [["A-1", "A-2"]]));
    expect(layout.independent.map((n) => n.id)).toEqual(["A-3"]);
    expect(columns(layout)).toEqual([["A-1"], ["A-2"]]);
  });

  test("Project 外のノードとだけつながる Issue は依存関係なしにしない", () => {
    const layout = layoutFlow(flow(["A-1", "B-9"], [["B-9", "A-1"]], { "B-9": { external: true, project: null } }));
    expect(layout.independent).toEqual([]);
    expect(columns(layout)).toEqual([["B-9"], ["A-1"]]);
  });

  test("依存辺が1件もなければ、すべて依存関係なしになる", () => {
    const layout = layoutFlow(flow(["A-1", "A-2"], []));
    expect(layout.independent.map((n) => n.id)).toEqual(["A-1", "A-2"]);
    expect(layout.cards).toEqual([]);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
  });

  test("Issue がなければ空", () => {
    const layout = layoutFlow({ projectId: 1, nodes: [], edges: [] });
    expect(layout).toMatchObject({ cards: [], edges: [], independent: [], cycle: [], width: 0, height: 0 });
  });

  test("循環は別枠に出し、残りは段に並べる", () => {
    const layout = layoutFlow(flow(
      ["A-1", "A-2", "A-3", "A-4", "A-5"],
      [["A-1", "A-2"], ["A-2", "A-3"], ["A-3", "A-2"], ["A-3", "A-4"], ["A-1", "A-5"]],
    ));
    expect(layout.cycle.map((n) => n.id)).toEqual(["A-2", "A-3"]);
    expect(columns(layout)).toEqual([["A-1", "A-4"], ["A-5"]]);
    expect(layout.edges.map((e) => [e.from, e.to])).toEqual([["A-1", "A-5"]]);
    expect(layout.predecessors.get("A-2")).toEqual(["A-1", "A-3"]);
    // 循環へ続く辺は図に描けないため、前提側のカードに循環の中の後続を示し、その行の高さを足す
    expect(layout.cycleSuccessors.get("A-1")).toEqual(["A-2"]);
    expect(layout.cycleSuccessors.has("A-5")).toBe(false);
    const height = (id: string) => layout.cards.find((c) => c.node.id === id)!.height;
    expect(height("A-1")).toBe(cardHeight(node("A-1"), false, true));
    expect(height("A-1")).toBeGreaterThan(CARD_HEIGHT);
  });

  test("自分自身をブロックする Issue も循環として扱う", () => {
    const layout = layoutFlow(flow(["A-1"], [["A-1", "A-1"]]));
    expect(layout.cycle.map((n) => n.id)).toEqual(["A-1"]);
    expect(layout.cards).toEqual([]);
  });

  test("段をまたぐ矢印は、途中の列でカードの上を通らない", () => {
    // A-1 → A-2 → A-3 → A-4 と A-1 → A-4。A-1 → A-4 は A-2・A-3 の列を通る
    const layout = layoutFlow(flow(["A-1", "A-2", "A-3", "A-4"], [["A-1", "A-2"], ["A-2", "A-3"], ["A-3", "A-4"], ["A-1", "A-4"]]));
    expect(columns(layout)).toEqual([["A-1"], ["A-2"], ["A-3"], ["A-4"]]);
    const long = layout.edges.find((e) => e.from === "A-1" && e.to === "A-4")!;
    for (const card of layout.cards.filter((c) => c.node.id === "A-2" || c.node.id === "A-3")) {
      long.points.slice(1).forEach((p, i) => {
        const q = long.points[i]!;
        if (p.y !== q.y) return;
        const crossesX = Math.min(p.x, q.x) < card.x + CARD_WIDTH && Math.max(p.x, q.x) > card.x;
        const insideY = p.y > card.y && p.y < card.y + card.height;
        expect(crossesX && insideY).toBe(false);
      });
    }
  });

  test("列の中は前提の位置の順に並べ、交差を減らす", () => {
    // A-1 → A-4、A-2 → A-3。後続の列は前提の順（A-4 が上）になる
    const layout = layoutFlow(flow(["A-1", "A-2", "A-3", "A-4"], [["A-1", "A-4"], ["A-2", "A-3"]]));
    expect(columns(layout)).toEqual([["A-1", "A-2"], ["A-4", "A-3"]]);
  });

  test("大量の Issue でも終わり、すべてを並べる", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `A-${i + 1}`);
    const edges = ids.slice(1).map((id, i) => [ids[i]!, id] as [string, string]);
    const layout = layoutFlow(flow(ids, edges));
    expect(layout.cards.length).toBe(2000);
  });
});

describe("flowNodeState", () => {
  test("完了・対応中・着手可能・前提待ちを見分け、それ以外は状態のまま", () => {
    expect(flowNodeState(node("A-1", { status: "done", ready: false }))).toBe("done");
    expect(flowNodeState(node("A-1", { status: "in_progress", ready: false, openBlockers: ["A-2"] }))).toBe("in_progress");
    expect(flowNodeState(node("A-1", { status: "todo", ready: true }))).toBe("ready");
    expect(flowNodeState(node("A-1", { status: "todo", ready: false, openBlockers: ["A-2"] }))).toBe("waiting");
    expect(flowNodeState(node("A-1", { status: "backlog", ready: false, openBlockers: ["A-2"] }))).toBe("waiting");
    // 前提がなくても着手できない Issue（Triage、未決事項のある Todo など）は着手可能にしない
    expect(flowNodeState(node("A-1", { status: "triage", ready: false }))).toBe("other");
    expect(flowNodeState(node("A-1", { status: "todo", ready: false }))).toBe("other");
    expect(flowNodeState(node("A-1", { status: "canceled", ready: false }))).toBe("canceled");
  });
});
