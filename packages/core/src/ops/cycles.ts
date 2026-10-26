import type { Database } from "bun:sqlite";
import type { OpCtx } from "../ctx";
import { NodError } from "../errors";
import type { CycleDetail, CycleSummary } from "../types";
import { dateFormatter } from "./stats";

// CLI/API/Webの段階的な切替中だけ残す旧契約。新規の期間管理には公開しない。
export interface CycleClock { tz?: string; today?: string; now?: Date }
export const CURRENT_CYCLE_REF = "current";
export function cycleToday(clock: CycleClock = {}): string {
  return clock.today ?? dateFormatter(clock.tz).format(clock.now ?? new Date());
}
export function cycleRetired(): never {
  throw new NodError("CYCLE_RETIRED", "Cycleの操作は廃止されました。Sprint履歴を参照し、候補と採択で計画してください");
}
export interface CreateCycleInput { name: string; startDate: string; endDate: string }
export interface UpdateCycleInput { name?: string; startDate?: string; endDate?: string }
export interface MoveOpenIssuesResult { moved: string[]; from: CycleSummary; to: CycleSummary }
export function resolveCycle(_db: Database, _ref: string, _clock: CycleClock = {}): {id:number;name:string} { return cycleRetired(); }
export function assertFree(_db: Database, _name: string, _start: string, _end: string, _selfId?: number): void { cycleRetired(); }
export function insertCycle(_db: Database, _actor: string, _name: string, _start: string, _end: string): number { return cycleRetired(); }
export function summaryById(_db: Database, _id: number, _today: string): CycleSummary { return cycleRetired(); }
export function createCycle(_ctx: OpCtx, _input: CreateCycleInput, _clock: CycleClock = {}): CycleSummary { return cycleRetired(); }
export function updateCycle(_ctx: OpCtx, _ref: string, _input: UpdateCycleInput, _clock: CycleClock = {}): CycleSummary { return cycleRetired(); }
export function deleteCycle(_ctx: OpCtx, _ref: string, _clock: CycleClock = {}): {id:number;name:string;issues:number} { return cycleRetired(); }
export function listCycles(_db: Database, _clock: CycleClock = {}): CycleSummary[] { return cycleRetired(); }
export function getCycle(_db: Database, _ref: string, _clock: CycleClock = {}): CycleDetail { return cycleRetired(); }
export function moveOpenIssues(_ctx: OpCtx, _fromRef: string, _toRef: string, _clock: CycleClock = {}, _opts: {automation?:string} = {}): MoveOpenIssuesResult { return cycleRetired(); }
