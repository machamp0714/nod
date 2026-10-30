import type { Database } from "bun:sqlite";
import type { OpCtx } from "../ctx";
import type { CycleCadence, CycleSummary } from "../types";
import { cycleRetired, type CycleClock, type MoveOpenIssuesResult } from "./cycles";
import { dateFormatter } from "./stats";

// 旧分析APIの移行が終わるまで残す暦日計算。
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const CYCLE_CARRY_OVER = "cycle-carry-over";
export function getCadence(_db: Database): CycleCadence | null { return cycleRetired(); }
export function setCadence(_ctx: OpCtx, _input: {weeks:number;autoCarryOver?:boolean;anchorDate?:string}, _clock: CycleClock = {}): CycleCadence { return cycleRetired(); }
export function clearCadence(_ctx: OpCtx): void { cycleRetired(); }
export function syncClockOf(tz: unknown): CycleClock {
  if (typeof tz !== "string" || !tz) return {};
  try { dateFormatter(tz); return {tz}; } catch { return {}; }
}
// 旧CLI/APIの通常入口が残っている間も、同期や持越しは一切行わない。
export function syncCycles(_ctx: OpCtx, _clock: CycleClock = {}): {created:CycleSummary[];carried:MoveOpenIssuesResult[]} {
  return {created:[],carried:[]};
}
