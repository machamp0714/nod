import type { Database } from "bun:sqlite";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { isValidDueDateInput, MIN_DUE_DATE } from "../due-date";
import { NodError } from "../errors";
import { selectIssues } from "../issue-query";
import { isNoneRef, NONE_REF } from "../none-ref";
import type { Cycle, CycleDetail, CycleState, CycleSummary, Issue } from "../types";
import { updateIssue } from "./issues";
import { dateFormatter } from "./stats";

// 「今日」の決め方。tz は IANA の名前で、省略時は実行環境のローカル（分析の stats と同じ規則）。today はテストや呼び出し側で決めた暦日
export interface CycleClock {
  tz?: string;
  today?: string;
  now?: Date; // テスト用。today を省いたときの基準の時刻
}

// ref に使えない名前。current は現在の Cycle を指す
export const CURRENT_CYCLE_REF = "current";

export function cycleToday(clock: CycleClock = {}): string {
  return clock.today ?? dateFormatter(clock.tz).format(clock.now ?? new Date());
}

interface CycleRow {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  carried_over_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface SummaryRow extends CycleRow {
  total: number;
  done: number;
}

function stateOf(r: { start_date: string; end_date: string }, today: string): CycleState {
  if (today < r.start_date) return "upcoming";
  return today > r.end_date ? "completed" : "current";
}

function toCycle(r: CycleRow, today: string): Cycle {
  return {
    id: r.id,
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    state: stateOf(r, today),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toSummary(r: SummaryRow, today: string): CycleSummary {
  return { ...toCycle(r, today), total: r.total, done: r.done, open: r.total - r.done };
}

// 進捗は Project と同じ定義
const SUMMARY_SELECT = `SELECT c.*,
  (SELECT count(*) FROM issues i WHERE i.cycle_id = c.id AND i.archived_at IS NULL AND i.status <> 'canceled') AS total,
  (SELECT count(*) FROM issues i WHERE i.cycle_id = c.id AND i.archived_at IS NULL AND i.status = 'done') AS done
FROM cycles c`;

function notFound(message: string): NodError {
  return new NodError("NOT_FOUND", message);
}

// Cycle を ID・名前・current から引く
export function resolveCycle(db: Database, ref: string, clock: CycleClock = {}): { id: number; name: string } {
  const trimmed = ref.trim();
  let row: { id: number; name: string } | null;
  if (/^\d+$/.test(trimmed)) {
    row = db.query("SELECT id, name FROM cycles WHERE id = ?").get(Number(trimmed)) as typeof row;
    if (!row) throw notFound(`Cycle ${trimmed} はありません`);
  } else if (trimmed.toLowerCase() === CURRENT_CYCLE_REF) {
    const today = cycleToday(clock);
    row = db.query("SELECT id, name FROM cycles WHERE start_date <= ? AND end_date >= ?").get(today, today) as typeof row;
    if (!row) throw notFound(`現在（${today}）の Cycle はありません`);
  } else {
    row = db.query("SELECT id, name FROM cycles WHERE name = ?").get(trimmed) as typeof row;
    if (!row) throw notFound(`Cycle ${trimmed} はありません`);
  }
  return row;
}

function validateName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) throw new NodError("INVALID_ARGS", "Cycle の名前を指定してください");
  if (/^\d+$/.test(name.trim())) {
    throw new NodError("INVALID_ARGS", `Cycle の名前に数字だけ（${name}）は使えません。数字は ID として解釈されるためです`);
  }
  if (name.trim().toLowerCase() === CURRENT_CYCLE_REF) {
    throw new NodError("INVALID_ARGS", `Cycle の名前に ${CURRENT_CYCLE_REF} は使えません。現在の Cycle を指す名前として予約しています`);
  }
  if (isNoneRef(name)) {
    throw new NodError("INVALID_ARGS", `Cycle の名前に ${NONE_REF} は使えません。絞り込みで Cycle のない Issue を指す値として予約しています`);
  }
  return name.trim();
}

function validateDate(date: unknown, what: string): string {
  if (typeof date !== "string" || !isValidDueDateInput(date)) {
    throw new NodError("INVALID_ARGS", `${what}は ${MIN_DUE_DATE} 以降の YYYY-MM-DD の日付で指定してください（${String(date)}）`);
  }
  return date;
}

function validateRange(start: string, end: string): void {
  if (start > end) throw new NodError("INVALID_ARGS", `開始日（${start}）は終了日（${end}）以前にしてください`);
}

// ほかの Cycle と名前・期間が重ならないか調べる。selfId は更新中の Cycle
export function assertFree(db: Database, name: string, start: string, end: string, selfId?: number): void {
  const sameName = db.query("SELECT id FROM cycles WHERE name = ?").get(name) as { id: number } | null;
  if (sameName && sameName.id !== selfId) throw new NodError("CYCLE_EXISTS", `Cycle ${name} はすでにあります`);
  const overlap = db
    .query("SELECT name, start_date, end_date FROM cycles WHERE id <> ? AND start_date <= ? AND end_date >= ? ORDER BY start_date LIMIT 1")
    .get(selfId ?? 0, end, start) as { name: string; start_date: string; end_date: string } | null;
  if (overlap) {
    throw new NodError("CYCLE_OVERLAP", `期間が Cycle ${overlap.name}（${overlap.start_date}〜${overlap.end_date}）と重なります。Cycle は期間を重ねられません`);
  }
}

// Cycle の行を足して ID を返す。名前・期間の検査は呼び出し側で行う
export function insertCycle(db: Database, actor: string, name: string, start: string, end: string): number {
  const ts = now();
  const { lastInsertRowid } = db
    .query("INSERT INTO cycles (name, start_date, end_date, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(name, start, end, actor, ts, ts);
  return Number(lastInsertRowid);
}

export function summaryById(db: Database, id: number, today: string): CycleSummary {
  return toSummary(db.query(`${SUMMARY_SELECT} WHERE c.id = ?`).get(id) as SummaryRow, today);
}

export interface CreateCycleInput {
  name: string;
  startDate: string;
  endDate: string;
}

export function createCycle(ctx: OpCtx, input: CreateCycleInput, clock: CycleClock = {}): CycleSummary {
  const name = validateName(input.name);
  const start = validateDate(input.startDate, "開始日");
  const end = validateDate(input.endDate, "終了日");
  validateRange(start, end);
  const today = cycleToday(clock);
  return tx(ctx.db, () => {
    assertFree(ctx.db, name, start, end);
    return summaryById(ctx.db, insertCycle(ctx.db, ctx.actor, name, start, end), today);
  });
}

export interface UpdateCycleInput {
  name?: string;
  startDate?: string;
  endDate?: string;
}

// 名前・期間を変える。所属 Issue には触れない
export function updateCycle(ctx: OpCtx, ref: string, input: UpdateCycleInput, clock: CycleClock = {}): CycleSummary {
  if (input.name === undefined && input.startDate === undefined && input.endDate === undefined) {
    throw new NodError("INVALID_ARGS", "変更する項目（名前・開始日・終了日）を1つ以上指定してください");
  }
  if (input.name !== undefined) validateName(input.name);
  if (input.startDate !== undefined) validateDate(input.startDate, "開始日");
  if (input.endDate !== undefined) validateDate(input.endDate, "終了日");
  const today = cycleToday(clock);
  return tx(ctx.db, () => {
    const { id } = resolveCycle(ctx.db, ref, clock);
    const row = ctx.db.query("SELECT * FROM cycles WHERE id = ?").get(id) as CycleRow;
    const name = input.name === undefined ? row.name : validateName(input.name);
    const start = input.startDate ?? row.start_date;
    const end = input.endDate ?? row.end_date;
    if (name === row.name && start === row.start_date && end === row.end_date) return summaryById(ctx.db, id, today);
    validateRange(start, end);
    assertFree(ctx.db, name, start, end, id);
    ctx.db
      .query("UPDATE cycles SET name = ?, start_date = ?, end_date = ?, updated_at = ? WHERE id = ?")
      .run(name, start, end, now(), id);
    return summaryById(ctx.db, id, today);
  });
}

// Cycle を消す。所属 Issue は Cycle なしに戻る（ON DELETE SET NULL）。Issue の event は残さない。
// 所属がまとめて外れて戻せないため、削除は人だけ（作成・編集は LLM もできる。Milestone と同じ）
export function deleteCycle(ctx: OpCtx, ref: string, clock: CycleClock = {}): { id: number; name: string; issues: number } {
  if (isLlm(ctx)) throw new NodError("FORBIDDEN_FOR_LLM", "LLM は Cycle を削除できません。削除は me に依頼してください");
  return tx(ctx.db, () => {
    const cycle = resolveCycle(ctx.db, ref, clock);
    const { n } = ctx.db.query("SELECT count(*) AS n FROM issues WHERE cycle_id = ?").get(cycle.id) as { n: number };
    ctx.db.query("DELETE FROM cycles WHERE id = ?").run(cycle.id);
    return { ...cycle, issues: n };
  });
}

// 開始日の順
export function listCycles(db: Database, clock: CycleClock = {}): CycleSummary[] {
  const today = cycleToday(clock);
  return (db.query(`${SUMMARY_SELECT} ORDER BY c.start_date`).all() as SummaryRow[]).map((r) => toSummary(r, today));
}

export function getCycle(db: Database, ref: string, clock: CycleClock = {}): CycleDetail {
  const { id } = resolveCycle(db, ref, clock);
  return {
    ...summaryById(db, id, cycleToday(clock)),
    issues: selectIssues(db, "WHERE i.cycle_id = ? AND i.archived_at IS NULL ORDER BY w.key, i.number", [id]),
  };
}

export interface MoveOpenIssuesResult {
  moved: string[]; // 移した Issue の ID
  from: CycleSummary;
  to: CycleSummary;
}

// 未完了（done・canceled 以外、アーカイブ以外）の Issue を別の Cycle へまとめて移す。
// 自動持ち越しの内部でだけ使う。Issue ごとに cycle_changed を記録する
export function moveOpenIssues(ctx: OpCtx, fromRef: string, toRef: string, clock: CycleClock = {}): MoveOpenIssuesResult {
  return tx(ctx.db, () => {
    const from = resolveCycle(ctx.db, fromRef, clock);
    const to = resolveCycle(ctx.db, toRef, clock);
    if (from.id === to.id) throw new NodError("INVALID_ARGS", "移動元と移動先に同じ Cycle は指定できません");
    const open: Issue[] = selectIssues(
      ctx.db,
      "WHERE i.cycle_id = ? AND i.archived_at IS NULL AND i.status NOT IN ('done', 'canceled') ORDER BY w.key, i.number",
      [from.id],
    );
    for (const issue of open) updateIssue(ctx, issue.id, { cycleRef: String(to.id) });
    const today = cycleToday(clock);
    return { moved: open.map((i) => i.id), from: summaryById(ctx.db, from.id, today), to: summaryById(ctx.db, to.id, today) };
  });
}
