import type { Cycle, CycleState } from "../api/types";

export const CYCLE_STATE_LABEL: Record<CycleState, string> = { current: "Current", upcoming: "Upcoming", completed: "Completed" };

// 「2026-09-08 – 09-21」。年をまたぐときは終了日も年から書く
export function formatCyclePeriod(cycle: Pick<Cycle, "startDate" | "endDate">): string {
  const sameYear = cycle.startDate.slice(0, 4) === cycle.endDate.slice(0, 4);
  return `${cycle.startDate} – ${sameYear ? cycle.endDate.slice(5) : cycle.endDate}`;
}

// 見出し・選択肢の表記「Sprint 12（Current）」
export function cycleLabel(cycle: Pick<Cycle, "name" | "state">): string {
  return `${cycle.name}（${CYCLE_STATE_LABEL[cycle.state]}）`;
}
