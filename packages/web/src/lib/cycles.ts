import type { Cycle, CycleCadence, CycleState } from "../api/types";
import { cycleMenu } from "./bulk-selection";

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

// Cycles 一覧の見出しの下に出す周期の要約。次は最初の予定の Cycle
export function formatCadence(c: CycleCadence | null, cycles: readonly Pick<Cycle, "name" | "startDate" | "state">[]): string {
  if (!c) return "周期は未設定です";
  const next = cycles.find((x) => x.state === "upcoming");
  return [`${c.weeks}週間ごと`, `自動持ち越し ${c.autoCarryOver ? "ON" : "OFF"}`, ...(next ? [`次は ${next.name}（${next.startDate.slice(5)}〜）`] : [])].join(" · ");
}

// サイドバーの「Current」の行き先。今の Cycle の詳細、なければ一覧。読み込み前は出さない
export function currentCycleLink(cycles: readonly Pick<Cycle, "id" | "name" | "state">[] | undefined): { to: string; label: string } | null {
  if (!cycles) return null;
  const current = cycles.find((c) => c.state === "current");
  return current ? { to: `/cycles/${current.id}`, label: current.name } : { to: "/cycles", label: "なし" };
}

// Issue に付ける Cycle の選択肢。終了していない Cycle を current を先に開始日の順で並べ、今付いている Cycle は終了していても残す
export function cycleChoices(
  cycles: readonly Pick<Cycle, "id" | "name" | "state" | "startDate">[],
  assigned: { id: number; name: string } | null,
): { id: number; name: string }[] {
  const choices = cycleMenu(cycles).map((c) => ({ id: c.id, name: c.name }));
  if (assigned && !choices.some((c) => c.id === assigned.id)) choices.push({ id: assigned.id, name: assigned.name });
  return choices;
}
