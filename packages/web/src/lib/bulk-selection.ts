// Issue 一覧の一括編集の選択。選択は URL に残さず、一覧の中だけで持つ。
// 同じ Issue が複数のグループに出ても1件として扱えるよう、ID の集合で持つ

export interface Selection {
  ids: ReadonlySet<string>;
  // Shift で範囲を選ぶときの起点（最後にクリックした行）。ラベルのグループでは同じ Issue が何度も出るため、表示位置も持つ
  anchor: { id: string; at: number } | null;
}

export interface BulkFailure {
  id: string;
  code: string;
  message: string;
}

// 1回の一括編集で送れる件数。サーバーの BULK_UPDATE_LIMIT（core/src/ops/bulk-update.ts）と同じ値
export const BULK_SELECT_LIMIT = 100;

// positions は表示順の ID（ラベルのグループでは同じ ID が何度も出る）、at はクリックした行の位置。
// Shift の範囲は起点の今の状態にそろえる。一覧の更新で起点の位置がずれていたら、その Issue の最初の位置を使う
export function toggleSelection(selection: Selection, positions: readonly string[], at: number, shift: boolean): Selection {
  const id = positions[at];
  if (id === undefined) return selection;
  const next = new Set(selection.ids);
  const anchor = selection.anchor;
  const from = anchor === null ? -1 : positions[anchor.at] === anchor.id ? anchor.at : positions.indexOf(anchor.id);
  if (shift && anchor && from !== -1) {
    const select = next.has(anchor.id);
    for (const rangeId of positions.slice(Math.min(from, at), Math.max(from, at) + 1)) {
      if (select) next.add(rangeId);
      else next.delete(rangeId);
    }
  } else if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return { ids: next, anchor: { id, at } };
}

export function selectAllState(ids: ReadonlySet<string>, order: readonly string[]): "none" | "some" | "all" {
  const count = order.filter((id) => ids.has(id)).length;
  return count === 0 ? "none" : count === order.length ? "all" : "some";
}

export function toggleAll(ids: ReadonlySet<string>, order: readonly string[]): Set<string> {
  const next = new Set(ids);
  const all = selectAllState(ids, order) === "all";
  for (const id of order) {
    if (all) next.delete(id);
    else next.add(id);
  }
  return next;
}

// 絞り込みや SSE の更新で一覧から消えた Issue は、見えないまま編集しないよう選択から外す
export function pruneSelection<T extends ReadonlySet<string>>(ids: T, order: readonly string[]): T | Set<string> {
  const visible = new Set(order);
  return [...ids].every((id) => visible.has(id)) ? ids : new Set([...ids].filter((id) => visible.has(id)));
}

export function bulkFailures(err: unknown): BulkFailure[] {
  const e = err as { code?: unknown; details?: { failures?: unknown } } | null;
  if (e?.code !== "BULK_UPDATE_FAILED" || !Array.isArray(e.details?.failures)) return [];
  return e.details.failures as BulkFailure[];
}

export interface LabelMenu {
  add: string[]; // 選択中のすべてには付いていないラベル
  create: string | null; // 検索語がどのラベルとも一致しないとき、新しいラベルとして足せる
  remove: { label: string; count: number }[]; // 選択中の1件以上に付いているラベルと、その件数
}

// design/nod.pen「Issues｜一括編集」(b) ラベルのメニュー
export function labelMenu(selected: readonly { labels: readonly string[] }[], known: readonly string[], query: string): LabelMenu {
  const q = query.trim();
  const counts = new Map<string, number>();
  for (const issue of selected) for (const label of new Set(issue.labels)) counts.set(label, (counts.get(label) ?? 0) + 1);
  const all = [...new Set([...known, ...counts.keys()])].sort();
  const matches = (label: string) => q === "" || label.toLowerCase().includes(q.toLowerCase());
  return {
    add: all.filter((label) => matches(label) && (counts.get(label) ?? 0) < selected.length),
    // 空白や区切り文字を含む語は、既存のラベル入力（parseLabels）と同じく1つのラベルとして作らない
    create: q !== "" && !/[\s,、，]/.test(q) && !all.includes(q) ? q : null,
    remove: all.filter((label) => matches(label) && counts.has(label)).map((label) => ({ label, count: counts.get(label) as number })),
  };
}
