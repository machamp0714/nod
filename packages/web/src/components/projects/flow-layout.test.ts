import { describe, expect, test } from "bun:test";
import type { ProjectFlow, ProjectFlowNode } from "../../api/types";
import { CARD_HEIGHT, CARD_WIDTH, COLUMN_GAP, flowNodeState, layoutFlow, ROW_GAP } from "./flow-layout";

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
    expect(layout.height).toBe(2 * CARD_HEIGHT + ROW_GAP);
  });

  test("矢印は前提の右端の中央から後続の左端の中央へ、縦横の線でつなぐ", () => {
    const layout = layoutFlow(flow(["A-1", "A-2", "A-3"], [["A-1", "A-2"], ["A-1", "A-3"]]));
    const card = (id: string) => layout.cards.find((c) => c.node.id === id)!;
    for (const edge of layout.edges) {
      const from = card(edge.from);
      const to = card(edge.to);
      expect(edge.points[0]).toEqual({ x: from.x + CARD_WIDTH, y: from.y + CARD_HEIGHT / 2 });
      expect(edge.points.at(-1)).toEqual({ x: to.x, y: to.y + CARD_HEIGHT / 2 });
      edge.points.slice(1).forEach((p, i) => {
        const q = edge.points[i]!;
        expect(p.x === q.x || p.y === q.y).toBe(true);
      });
    }
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
        const insideY = p.y > card.y && p.y < card.y + CARD_HEIGHT;
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
