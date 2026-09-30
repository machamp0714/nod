import type { Cycle, CycleState } from "../api/types";

export const CYCLE_STATE_LABEL: Record<CycleState, string> = { current: "Current", upcoming: "Upcoming", completed: "Completed" };

// 「2026-09-08 – 09-21」。年をまたぐときは終了日も年から書く
export function formatCyclePeriod(cycle: Pick<Cycle, "startDate" | "endDate">): string {
  const sameYear = cycle.startDate.slice(0, 4) === cycle.endDate.slice(0, 4);
  return `${cycle.startDate} – ${sameYear ? cycle.endDate.slice(5) : cycle.endDate}`;
}

// 見出し・選択肢の表記「Sprint 12（Current）」。同じ名前の Cycle が別の Workspace にあるときだけ「· キー」を足す
export function cycleLabel(cycle: Pick<Cycle, "id" | "name" | "state" | "workspace">, all: readonly Pick<Cycle, "id" | "name" | "workspace">[]): string {
  const base = `${cycle.name}（${CYCLE_STATE_LABEL[cycle.state]}）`;
  const ambiguous = all.some((c) => c.id !== cycle.id && c.name === cycle.name && c.workspace !== cycle.workspace);
  return ambiguous ? `${base} · ${cycle.workspace}` : base;
}

// 未完了を移す先の既定。移動元以外で、現在の Cycle があればそれ、なければ（移動元が現在なら）次の予定の Cycle。
// cycles は同じ Workspace の Cycle を開始日の順に並べたもの
export function defaultDestination<T extends Pick<Cycle, "id" | "state" | "startDate">>(source: Pick<Cycle, "id" | "startDate">, cycles: readonly T[]): T | undefined {
  const others = cycles.filter((c) => c.id !== source.id);
  return others.find((c) => c.state === "current") ?? others.find((c) => c.state === "upcoming" && c.startDate > source.startDate) ?? others.find((c) => c.state === "upcoming");
}
