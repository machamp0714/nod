// Issue 一覧の一括編集の選択。選択は URL に残さず、一覧の中だけで持つ。
// 同じ Issue が複数のグループに出ても1件として扱えるよう、ID の集合で持つ

export interface Selection {
  ids: ReadonlySet<string>;
  anchor: string | null; // Shift で範囲を選ぶときの起点（最後にクリックした行）
}

export interface BulkFailure {
  id: string;
  code: string;
  message: string;
}

// order は表示順の ID（重複なし）。Shift の範囲は起点の今の状態にそろえる
export function toggleSelection(selection: Selection, order: readonly string[], id: string, shift: boolean): Selection {
  const next = new Set(selection.ids);
  const from = selection.anchor === null ? -1 : order.indexOf(selection.anchor);
  const to = order.indexOf(id);
  if (shift && from !== -1 && to !== -1) {
    const select = next.has(selection.anchor as string);
    for (const rangeId of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
      if (select) next.add(rangeId);
      else next.delete(rangeId);
    }
  } else if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return { ids: next, anchor: id };
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
