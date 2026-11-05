import type { Database } from "bun:sqlite";
import type { OpCtx } from "../ctx";
import type { CycleCadence } from "../types";
import { cycleRetired, type CycleClock } from "./cycles";

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
