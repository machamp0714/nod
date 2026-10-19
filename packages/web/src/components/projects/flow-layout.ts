import type { ProjectFlow, ProjectFlowNode } from "../../api/types";

// design/nod.pen「Project詳細｜フロー」（R4bvo）のカードと間隔。位置を計算するためカードは固定の大きさにする
export const CARD_WIDTH = 232;
export const CARD_HEIGHT = 148; // ID・2行のタイトル・状態・前提・Project 外の行が入る高さ
export const COLUMN_GAP = 48;
export const ROW_GAP = 16;
// 段をまたぐ矢印が途中の列で通る帯の高さ
const LANE_HEIGHT = 8;

export interface FlowPoint {
  x: number;
  y: number;
}

export interface FlowCard {
  node: ProjectFlowNode;
  x: number;
  y: number;
}

export interface FlowEdgePath {
  from: string;
  to: string;
  points: FlowPoint[]; // 前提の右端の中央から後続の左端の中央まで、縦横の線だけでつなぐ
}

export interface FlowLayout {
  cards: FlowCard[];
  edges: FlowEdgePath[];
  width: number;
  height: number;
  independent: ProjectFlowNode[]; // 依存辺を持たない主対象
  cycle: ProjectFlowNode[]; // 循環に含まれる Issue（段に並べない）
  predecessors: Map<string, string[]>; // 各 Issue の直接の前提（循環の中の辺も含む）
}

// カードの状態。完了・中止の前提は待ちの原因にしない（openBlockers に入らない）。
// other は Triage や未決事項のある Todo など、前提以外の理由で着手できないもので、状態名のまま出す
export type FlowNodeState = "done" | "canceled" | "in_progress" | "ready" | "waiting" | "other";

export function flowNodeState(node: ProjectFlowNode): FlowNodeState {
  if (node.status === "done") return "done";
  if (node.status === "canceled") return "canceled";
  if (node.status === "in_progress") return "in_progress";
  if (node.ready) return "ready";
  if (node.openBlockers.length > 0) return "waiting";
  return "other";
}

interface Slot {
  key: string;
  node?: ProjectFlowNode; // ない場合は段をまたぐ矢印の通り道
  height: number;
  order: number; // API の並び順（同じ重心のときの順）
  y: number;
}

// 依存段階を横に、分岐を縦に並べる。循環は強連結成分で見つけて別枠に出し、残りだけを段に並べる
export function layoutFlow(flow: ProjectFlow): FlowLayout {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const order = new Map(flow.nodes.map((n, i) => [n.id, i]));
  const seen = new Set<string>();
  const edges = flow.edges.filter((e) => {
    const key = `${e.from}\u0000${e.to}`;
    if (!byId.has(e.from) || !byId.has(e.to) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();
  for (const e of edges) {
    predecessors.set(e.to, [...(predecessors.get(e.to) ?? []), e.from]);
    successors.set(e.from, [...(successors.get(e.from) ?? []), e.to]);
  }
  const connected = flow.nodes.filter((n) => predecessors.has(n.id) || successors.has(n.id));
  const independent = flow.nodes.filter((n) => !n.external && !predecessors.has(n.id) && !successors.has(n.id));
  const cyclic = cyclicNodes(connected.map((n) => n.id), successors);
  const cycle = connected.filter((n) => cyclic.has(n.id));
  const placed = connected.filter((n) => !cyclic.has(n.id));
  const placedEdges = edges.filter((e) => !cyclic.has(e.from) && !cyclic.has(e.to));

  // 最長路で段を決める（前提がすべて左の段に来る）
  const layer = new Map<string, number>();
  const indegree = new Map(placed.map((n) => [n.id, 0]));
  const outs = new Map<string, string[]>();
  for (const e of placedEdges) {
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    outs.set(e.from, [...(outs.get(e.from) ?? []), e.to]);
  }
  const queue = placed.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) layer.set(id, 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const next of outs.get(id) ?? []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, layer.get(id)! + 1));
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }

  // 段をまたぐ矢印は、途中の段に通り道を置いてカードの上を通らないようにする
  const layers: Slot[][] = [];
  const slotOf = new Map<string, { layer: number; slot: Slot }>();
  const addSlot = (l: number, slot: Slot) => {
    (layers[l] ??= []).push(slot);
    slotOf.set(slot.key, { layer: l, slot });
  };
  for (const n of placed) addSlot(layer.get(n.id)!, { key: n.id, node: n, height: CARD_HEIGHT, order: order.get(n.id)!, y: 0 });
  // 各スロットの左隣（前の段）のスロット
  const slotPreds = new Map<string, string[]>();
  const chains = placedEdges.map((e) => {
    const from = layer.get(e.from)!;
    const to = layer.get(e.to)!;
    const keys = [e.from];
    for (let l = from + 1; l < to; l++) {
      const key = `${e.from}\u0000${e.to}\u0000${l}`;
      addSlot(l, { key, height: LANE_HEIGHT, order: order.get(e.to)!, y: 0 });
      keys.push(key);
    }
    keys.push(e.to);
    for (let i = 1; i < keys.length; i++) slotPreds.set(keys[i]!, [...(slotPreds.get(keys[i]!) ?? []), keys[i - 1]!]);
    return { edge: e, keys };
  });

  // 段の中は前提の位置の平均（重心）の順、同じなら API の順。優先度は使わない
  const rank = new Map<string, number>();
  for (const slots of layers) {
    if (!slots) continue;
    const center = (slot: Slot) => {
      const preds = slotPreds.get(slot.key) ?? [];
      return preds.length ? preds.reduce((sum, key) => sum + rank.get(key)!, 0) / preds.length : -1;
    };
    const centers = new Map(slots.map((slot) => [slot.key, center(slot)]));
    slots.sort((a, b) => centers.get(a.key)! - centers.get(b.key)! || a.order - b.order);
    slots.forEach((slot, i) => rank.set(slot.key, i));
  }

  const columnHeight = (slots: Slot[]) => slots.reduce((sum, slot) => sum + slot.height, 0) + Math.max(0, slots.length - 1) * ROW_GAP;
  const height = layers.reduce((max, slots) => Math.max(max, columnHeight(slots ?? [])), 0);
  const columnX = (l: number) => l * (CARD_WIDTH + COLUMN_GAP);
  const cards: FlowCard[] = [];
  layers.forEach((slots, l) => {
    // 段ごとに上下中央へ寄せる
    let y = (height - columnHeight(slots)) / 2;
    for (const slot of slots) {
      slot.y = y;
      if (slot.node) cards.push({ node: slot.node, x: columnX(l), y });
      y += slot.height + ROW_GAP;
    }
  });
  cards.sort((a, b) => a.x - b.x || a.y - b.y);

  const edgePaths = chains.map(({ edge, keys }) => {
    const points: FlowPoint[] = [];
    keys.forEach((key, i) => {
      const { layer: l, slot } = slotOf.get(key)!;
      const mid = slot.y + slot.height / 2;
      const left = { x: columnX(l), y: mid };
      const right = { x: columnX(l) + CARD_WIDTH, y: mid };
      if (i > 0) {
        const prev = points[points.length - 1]!;
        const gapX = prev.x + COLUMN_GAP / 2;
        points.push({ x: gapX, y: prev.y }, { x: gapX, y: mid }, left);
      }
      if (i < keys.length - 1) points.push(right);
    });
    return { from: edge.from, to: edge.to, points: simplify(points) };
  });

  const width = layers.length ? columnX(layers.length - 1) + CARD_WIDTH : 0;
  return { cards, edges: edgePaths, width, height, independent, cycle, predecessors };
}

// 強連結成分（Tarjan の方法を再帰なしで）のうち、2件以上のものと自己ループの Issue
function cyclicNodes(ids: string[], successors: Map<string, string[]>): Set<string> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out = new Set<string>();
  let counter = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    const work: { id: string; next: number }[] = [{ id: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const nexts = successors.get(frame.id) ?? [];
      if (frame.next < nexts.length) {
        const next = nexts[frame.next++]!;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter++);
          stack.push(next);
          onStack.add(next);
          work.push({ id: next, next: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(next)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) !== index.get(frame.id)) continue;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.id);
      if (component.length > 1 || nexts.includes(frame.id)) for (const id of component) out.add(id);
    }
  }
  return out;
}

// 同じ点と、一直線上の途中の点を除く
function simplify(points: FlowPoint[]): FlowPoint[] {
  const out: FlowPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    const before = out[out.length - 2];
    if (before && last && ((before.x === last.x && last.x === p.x) || (before.y === last.y && last.y === p.y))) out.pop();
    out.push(p);
  }
  return out;
}
