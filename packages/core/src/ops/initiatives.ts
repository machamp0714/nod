import type { Database } from "bun:sqlite";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { isValidDueDateInput, MIN_DUE_DATE } from "../due-date";
import { NodError } from "../errors";
import {
  type Initiative,
  type InitiativeDetail,
  type InitiativeStatus,
  type InitiativeSummary,
  INITIATIVE_STATUSES,
  type UpdateInitiativeInput,
} from "../types";
import { resolveProject, selectProjectSummaries } from "./projects";

export function resolveInitiative(db: Database, ref: string): { id: number; name: string } {
  const row = (
    /^\d+$/.test(ref)
      ? db.query("SELECT id, name FROM initiatives WHERE id = ?").get(Number(ref))
      : db.query("SELECT id, name FROM initiatives WHERE name = ?").get(ref)
  ) as { id: number; name: string } | null;
  if (!row) throw new NodError("NOT_FOUND", `Initiative ${ref} はありません`);
  return row;
}

interface InitiativeRow {
  id: number;
  name: string;
  description: string | null;
  target_date: string | null;
  status: InitiativeStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface SummaryRow extends InitiativeRow {
  project_count: number;
  total: number;
  done: number;
}

function toInitiative(r: InitiativeRow): Initiative {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    targetDate: r.target_date,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toSummary(r: SummaryRow): InitiativeSummary {
  return { ...toInitiative(r), projectCount: r.project_count, total: r.total, done: r.done };
}

// 進捗は Project の total・done と同じ定義。Issue は1つの Project にしか属さないので二重に数えない
const inInitiative = "i.project_id IN (SELECT ip.project_id FROM initiative_projects ip WHERE ip.initiative_id = n.id) AND i.archived_at IS NULL";
const SUMMARY_SELECT = `SELECT n.*,
  (SELECT count(*) FROM initiative_projects ip WHERE ip.initiative_id = n.id) AS project_count,
  (SELECT count(*) FROM issues i WHERE ${inInitiative} AND i.status <> 'canceled') AS total,
  (SELECT count(*) FROM issues i WHERE ${inInitiative} AND i.status = 'done') AS done
FROM initiatives n`;

function validateName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) throw new NodError("INVALID_ARGS", "Initiative の名前を指定してください");
  if (/^\d+$/.test(name)) {
    throw new NodError("INVALID_ARGS", `Initiative の名前に数字だけ（${name}）は使えません。数字は ID として解釈されるためです`);
  }
  return name;
}

function validateTargetDate(date: string): void {
  if (!isValidDueDateInput(date)) {
    throw new NodError("INVALID_ARGS", `${date} は目標日として使えません（${MIN_DUE_DATE} 以降の YYYY-MM-DD の日付で指定してください。例: 2026-12-31）`);
  }
}

function assertNameFree(db: Database, name: string, selfId?: number): void {
  const hit = db.query("SELECT id FROM initiatives WHERE name = ?").get(name) as { id: number } | null;
  if (hit && hit.id !== selfId) throw new NodError("INITIATIVE_EXISTS", `Initiative ${name} はすでにあります`);
}

export function createInitiative(ctx: OpCtx, input: { name: string; description?: string; targetDate?: string }): Initiative {
  const name = validateName(input.name);
  if (input.targetDate !== undefined) validateTargetDate(input.targetDate);
  return tx(ctx.db, () => {
    assertNameFree(ctx.db, name);
    const ts = now();
    const { lastInsertRowid } = ctx.db
      .query("INSERT INTO initiatives (name, description, target_date, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(name, input.description ?? null, input.targetDate ?? null, ctx.actor, ts, ts);
    return toInitiative(ctx.db.query("SELECT * FROM initiatives WHERE id = ?").get(Number(lastInsertRowid)) as InitiativeRow);
  });
}

// 名前・説明・目標日・状態を変える。配下 Project と Issue には触れない
export function updateInitiative(ctx: OpCtx, ref: string, input: UpdateInitiativeInput): Initiative {
  if (Object.values(input).every((v) => v === undefined)) {
    throw new NodError("INVALID_ARGS", "変更する項目（名前・説明・目標日・状態）を1つ以上指定してください");
  }
  if (input.name !== undefined) validateName(input.name);
  if (input.status !== undefined && !(INITIATIVE_STATUSES as readonly unknown[]).includes(input.status)) {
    throw new NodError("INVALID_ARGS", `Initiative のステータスは ${INITIATIVE_STATUSES.join(", ")} で指定してください`);
  }
  if (input.targetDate != null) validateTargetDate(input.targetDate);
  return tx(ctx.db, () => {
    const { id } = resolveInitiative(ctx.db, ref);
    const row = ctx.db.query("SELECT * FROM initiatives WHERE id = ?").get(id) as InitiativeRow;
    const next: InitiativeRow = {
      ...row,
      name: input.name ?? row.name,
      description: input.description !== undefined ? input.description : row.description,
      target_date: input.targetDate !== undefined ? input.targetDate : row.target_date,
      status: input.status ?? row.status,
    };
    if (next.name === row.name && next.description === row.description && next.target_date === row.target_date && next.status === row.status) {
      return toInitiative(row);
    }
    if (next.name !== row.name) assertNameFree(ctx.db, next.name, id);
    next.updated_at = now();
    ctx.db
      .query("UPDATE initiatives SET name = ?, description = ?, target_date = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.description, next.target_date, next.status, next.updated_at, id);
    return toInitiative(next);
  });
}

export function listInitiatives(db: Database, opts: { includeClosed?: boolean } = {}): InitiativeSummary[] {
  const where = opts.includeClosed ? "" : "WHERE n.status NOT IN ('completed', 'canceled')";
  return (db.query(`${SUMMARY_SELECT} ${where} ORDER BY n.name`).all() as SummaryRow[]).map(toSummary);
}

export function getInitiative(db: Database, ref: string): InitiativeDetail {
  const { id } = resolveInitiative(db, ref);
  const row = db.query(`${SUMMARY_SELECT} WHERE n.id = ?`).get(id) as SummaryRow;
  return {
    ...toSummary(row),
    projects: selectProjectSummaries(
      db,
      "WHERE p.id IN (SELECT project_id FROM initiative_projects WHERE initiative_id = ?) ORDER BY p.name",
      [id],
    ),
  };
}

// Project を Initiative に紐付ける。すでに紐付いていれば何もしない
export function addInitiativeProject(ctx: OpCtx, ref: string, projectRef: string): InitiativeDetail {
  return tx(ctx.db, () => {
    const initiative = resolveInitiative(ctx.db, ref);
    const project = resolveProject(ctx.db, projectRef);
    ctx.db
      .query("INSERT OR IGNORE INTO initiative_projects (initiative_id, project_id, created_by, created_at) VALUES (?, ?, ?, ?)")
      .run(initiative.id, project.id, ctx.actor, now());
    return getInitiative(ctx.db, String(initiative.id));
  });
}

// 紐付けを外す。Project と Issue は残る
export function removeInitiativeProject(ctx: OpCtx, ref: string, projectRef: string): InitiativeDetail {
  return tx(ctx.db, () => {
    const initiative = resolveInitiative(ctx.db, ref);
    const project = resolveProject(ctx.db, projectRef);
    const { changes } = ctx.db
      .query("DELETE FROM initiative_projects WHERE initiative_id = ? AND project_id = ?")
      .run(initiative.id, project.id);
    if (changes === 0) throw new NodError("NOT_FOUND", `Project ${project.name} は Initiative ${initiative.name} に紐付いていません`);
    return getInitiative(ctx.db, String(initiative.id));
  });
}
