import type { Database } from "bun:sqlite";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { isValidDueDateInput } from "../due-date";
import { NodError } from "../errors";
import type { CycleCadence, CycleSummary } from "../types";
import { assertFree, type CycleClock, cycleToday, insertCycle, type MoveOpenIssuesResult, moveOpenIssues, summaryById } from "./cycles";

// 自動持ち越しの記録に付ける自動化名
export const CYCLE_CARRY_OVER = "cycle-carry-over";

interface CadenceRow {
  weeks: number;
  auto_carry_over: number;
  anchor_date: string;
  next_number: number;
  updated_by: string;
  updated_at: string;
}

// 暦日 YYYY-MM-DD に n 日足す（UTC で計算し、時差の影響を受けない）
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// base から L 日ずつ区切ったとき、today を含む区間の初日。today が base より前なら base
function gridStart(base: string, length: number, today: string): string {
  if (today < base) return base;
  return addDays(base, Math.floor(daysBetween(base, today) / length) * length);
}

export function getCadence(db: Database): CycleCadence | null {
  const r = db.query("SELECT * FROM cycle_cadence WHERE id = 1").get() as CadenceRow | null;
  return r && { weeks: r.weeks, autoCarryOver: r.auto_carry_over === 1, anchorDate: r.anchor_date, nextNumber: r.next_number, updatedBy: r.updated_by, updatedAt: r.updated_at };
}

function assertHuman(ctx: OpCtx): void {
  if (isLlm(ctx)) throw new NodError("FORBIDDEN_FOR_LLM", "LLM は Cycle の周期を設定・解除できません。me に依頼してください");
}

// すでに終わっている Cycle を「持ち越し済み」にする。周期の設定時と自動持ち越しを ON にしたとき、過去分をまとめて動かさないため
function markEndedAsCarried(db: Database, today: string): void {
  db.query("UPDATE cycles SET carried_over_at = ? WHERE end_date < ? AND carried_over_at IS NULL").run(now(), today);
}

// 周期を設定する。人だけ。anchorDate は Cycle が1つもないときの最初の開始日（省略時は今日）
export function setCadence(ctx: OpCtx, input: { weeks: number; autoCarryOver?: boolean; anchorDate?: string }, clock: CycleClock = {}): CycleCadence {
  assertHuman(ctx);
  if (!Number.isInteger(input.weeks) || input.weeks < 1 || input.weeks > 4) {
    throw new NodError("INVALID_ARGS", `周期は 1〜4 週で指定してください（${input.weeks}）`);
  }
  if (input.anchorDate !== undefined && !isValidDueDateInput(input.anchorDate)) {
    throw new NodError("INVALID_ARGS", `開始日は YYYY-MM-DD の日付で指定してください（${input.anchorDate}）`);
  }
  const today = cycleToday(clock);
  return tx(ctx.db, () => {
    const before = getCadence(ctx.db);
    const autoCarryOver = input.autoCarryOver ?? before?.autoCarryOver ?? true;
    const anchor = input.anchorDate ?? before?.anchorDate ?? today;
    if (!before || (autoCarryOver && !before.autoCarryOver)) markEndedAsCarried(ctx.db, today);
    ctx.db
      .query(
        `INSERT INTO cycle_cadence (id, weeks, auto_carry_over, anchor_date, next_number, updated_by, updated_at) VALUES (1, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET weeks = excluded.weeks, auto_carry_over = excluded.auto_carry_over, anchor_date = excluded.anchor_date,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(input.weeks, autoCarryOver ? 1 : 0, anchor, ctx.actor, now());
    return getCadence(ctx.db)!;
  });
}

// 周期を外す。人だけ。既存の Cycle は残す
export function clearCadence(ctx: OpCtx): void {
  assertHuman(ctx);
  ctx.db.query("DELETE FROM cycle_cadence WHERE id = 1").run();
}

// 次に作る Cycle の初日。作る必要がなければ null
function nextStart(db: Database, cadence: CycleCadence, today: string): string | null {
  const length = cadence.weeks * 7;
  const last = db.query("SELECT end_date FROM cycles ORDER BY end_date DESC LIMIT 1").get() as { end_date: string } | null;
  if (!last) return gridStart(cadence.anchorDate, length, today);
  if (last.end_date < today) return gridStart(addDays(last.end_date, 1), length, today);
  const ahead = db.query("SELECT 1 FROM cycles WHERE start_date > ? LIMIT 1").get(today);
  return ahead ? null : addDays(last.end_date, 1);
}

// 自動持ち越しの対象（終了していて印のない Cycle）と、その移動先
function carryTargets(db: Database, today: string): { from: number; to: number }[] {
  const ended = db.query("SELECT id, end_date FROM cycles WHERE end_date < ? AND carried_over_at IS NULL ORDER BY end_date").all(today) as { id: number; end_date: string }[];
  const current = db.query("SELECT id FROM cycles WHERE start_date <= ? AND end_date >= ?").get(today, today) as { id: number } | null;
  return ended.flatMap((c) => {
    const to = current ?? (db.query("SELECT id FROM cycles WHERE start_date > ? ORDER BY start_date LIMIT 1").get(c.end_date) as { id: number } | null);
    return to ? [{ from: c.id, to: to.id }] : [];
  });
}

function insertAutoCycle(ctx: OpCtx, cadence: CycleCadence, start: string): number {
  let n = cadence.nextNumber;
  while (ctx.db.query("SELECT 1 FROM cycles WHERE name = ?").get(`Cycle ${n}`)) n++;
  const end = addDays(start, cadence.weeks * 7 - 1);
  assertFree(ctx.db, `Cycle ${n}`, start, end);
  const id = insertCycle(ctx.db, ctx.actor, `Cycle ${n}`, start, end);
  ctx.db.query("UPDATE cycle_cadence SET next_number = ? WHERE id = 1").run(n + 1);
  cadence.nextNumber = n + 1;
  return id;
}

// 周期に従って不足している Cycle を作り、終了した Cycle の未完了を持ち越す。CLI・API の各呼び出しの最初に呼ぶ。
// やることがなければ読み取りだけで返す（書き込みのロックを取らない）。何度呼んでも結果は同じ
export function syncCycles(ctx: OpCtx, clock: CycleClock = {}): { created: CycleSummary[]; carried: MoveOpenIssuesResult[] } {
  const cadence = getCadence(ctx.db);
  if (!cadence) return { created: [], carried: [] };
  const today = cycleToday(clock);
  const pending = () => nextStart(ctx.db, cadence, today) !== null || (cadence.autoCarryOver && carryTargets(ctx.db, today).length > 0);
  if (!pending()) return { created: [], carried: [] };
  return tx(ctx.db, () => {
    const created: number[] = [];
    for (let start = nextStart(ctx.db, cadence, today); start !== null && created.length < 2; start = nextStart(ctx.db, cadence, today)) {
      created.push(insertAutoCycle(ctx, cadence, start));
    }
    const carried: MoveOpenIssuesResult[] = [];
    if (cadence.autoCarryOver) {
      for (const t of carryTargets(ctx.db, today)) {
        carried.push(moveOpenIssues(ctx, String(t.from), String(t.to), clock, { automation: CYCLE_CARRY_OVER }));
        ctx.db.query("UPDATE cycles SET carried_over_at = ? WHERE id = ?").run(now(), t.from);
      }
    }
    return { created: created.map((id) => summaryById(ctx.db, id, today)), carried: carried.filter((r) => r.moved.length > 0) };
  });
}
