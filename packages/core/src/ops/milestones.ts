import type { Database } from "bun:sqlite";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import type { Milestone } from "../types";
import { validateDueDate } from "./issues";
import { resolveProject } from "./projects";

export const MILESTONE_NAME_MAX_LENGTH = 200;
export const MILESTONE_DESCRIPTION_MAX_LENGTH = 10000;

interface MilestoneRow {
  id: number;
  project_id: number;
  name: string;
  target_date: string | null;
  description: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  total: number;
  done: number;
}

// 進捗は Project の total・done と同じ定義にそろえる
const MILESTONE_SELECT = `SELECT m.*,
  (SELECT count(*) FROM issues i WHERE i.milestone_id = m.id AND i.archived_at IS NULL AND i.status <> 'canceled') AS total,
  (SELECT count(*) FROM issues i WHERE i.milestone_id = m.id AND i.archived_at IS NULL AND i.status = 'done') AS done
FROM milestones m`;

const MILESTONE_ORDER = "ORDER BY m.target_date IS NULL, m.target_date, m.id";

function toMilestone(r: MilestoneRow): Milestone {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    targetDate: r.target_date,
    description: r.description,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    total: r.total,
    done: r.done,
  };
}

function milestoneById(db: Database, id: number): Milestone {
  return toMilestone(db.query(`${MILESTONE_SELECT} WHERE m.id = ?`).get(id) as MilestoneRow);
}

export function selectMilestones(db: Database, projectId: number): Milestone[] {
  return (db.query(`${MILESTONE_SELECT} WHERE m.project_id = ? ${MILESTONE_ORDER}`).all(projectId) as MilestoneRow[]).map(toMilestone);
}

// すべての Project の Milestone（Issue 一覧の絞り込みの選択肢）。Project の名前順、その中は目標日の早い順
export function listAllMilestones(db: Database): Milestone[] {
  return (
    db.query(`${MILESTONE_SELECT} JOIN projects p ON p.id = m.project_id ORDER BY p.name, m.target_date IS NULL, m.target_date, m.id`).all() as MilestoneRow[]
  ).map(toMilestone);
}

export function listMilestones(db: Database, projectRef: string): Milestone[] {
  return selectMilestones(db, resolveProject(db, projectRef).id);
}

// 数字だけの ref は Milestone の ID、それ以外は projectId の Project の中の名前として解決する
export function resolveMilestone(db: Database, ref: string | number, projectId?: number): { id: number; project_id: number; name: string } {
  const byId = typeof ref === "number" || /^\d+$/.test(ref);
  const row = (
    byId
      ? db.query("SELECT id, project_id, name FROM milestones WHERE id = ?").get(Number(ref))
      : projectId === undefined
        ? null
        : db.query("SELECT id, project_id, name FROM milestones WHERE project_id = ? AND name = ?").get(projectId, ref)
  ) as { id: number; project_id: number; name: string } | null;
  if (!row) throw new NodError("NOT_FOUND", `Milestone ${ref} はありません`);
  return row;
}

function validateName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) throw new NodError("INVALID_ARGS", "Milestone の名前を指定してください");
  if (/^\d+$/.test(name)) {
    throw new NodError("INVALID_ARGS", `Milestone の名前に数字だけ（${name}）は使えません。数字は ID として解釈されるためです`);
  }
  if (name.length > MILESTONE_NAME_MAX_LENGTH) {
    throw new NodError("INVALID_ARGS", `Milestone の名前は ${MILESTONE_NAME_MAX_LENGTH} 文字以内にしてください（${name.length} 文字）`);
  }
  return name;
}

function validateDescription(description: string): void {
  if (description.length > MILESTONE_DESCRIPTION_MAX_LENGTH) {
    throw new NodError(
      "INVALID_ARGS",
      `Milestone の説明は ${MILESTONE_DESCRIPTION_MAX_LENGTH} 文字以内にしてください（${description.length} 文字）`,
    );
  }
}

function ensureUniqueName(db: Database, projectId: number, name: string, exceptId?: number): void {
  const hit = db.query("SELECT id FROM milestones WHERE project_id = ? AND name = ?").get(projectId, name) as { id: number } | null;
  if (hit && hit.id !== exceptId) throw new NodError("MILESTONE_EXISTS", `同じ名前の Milestone「${name}」があります`);
}

export interface CreateMilestoneInput {
  name: string;
  targetDate?: string | null;
  description?: string | null;
}

export function createMilestone(ctx: OpCtx, projectRef: string, input: CreateMilestoneInput): Milestone {
  const name = validateName(input.name);
  if (input.targetDate != null) validateDueDate(input.targetDate);
  if (input.description != null) validateDescription(input.description);
  return tx(ctx.db, () => {
    const project = resolveProject(ctx.db, projectRef);
    ensureUniqueName(ctx.db, project.id, name);
    const ts = now();
    const { lastInsertRowid } = ctx.db
      .query(
        "INSERT INTO milestones (project_id, name, target_date, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(project.id, name, input.targetDate ?? null, input.description || null, ctx.actor, ts, ts);
    return milestoneById(ctx.db, Number(lastInsertRowid));
  });
}

export interface UpdateMilestoneInput {
  name?: string;
  targetDate?: string | null; // null で外す
  description?: string | null; // null か空文字で外す
}

// ref は Milestone の ID。projectId を渡すと、その Project の中の名前でも指定できる
export function updateMilestone(ctx: OpCtx, ref: string | number, input: UpdateMilestoneInput, projectId?: number): Milestone {
  if (input.name !== undefined) validateName(input.name);
  if (input.targetDate != null) validateDueDate(input.targetDate);
  if (input.description != null) validateDescription(input.description);
  return tx(ctx.db, () => {
    const row = resolveMilestone(ctx.db, ref, projectId);
    if (projectId !== undefined && row.project_id !== projectId) throw new NodError("NOT_FOUND", `Milestone ${ref} はこの Project にありません`);
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (input.name !== undefined && input.name !== row.name) {
      ensureUniqueName(ctx.db, row.project_id, input.name, row.id);
      sets.push("name = ?");
      params.push(input.name);
    }
    if (input.targetDate !== undefined) {
      sets.push("target_date = ?");
      params.push(input.targetDate);
    }
    if (input.description !== undefined) {
      sets.push("description = ?");
      params.push(input.description || null);
    }
    if (sets.length) {
      ctx.db.query(`UPDATE milestones SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...params, now(), row.id);
    }
    return milestoneById(ctx.db, row.id);
  });
}

// 消すと紐付いた Issue は Milestone から外れるだけで、Issue の状態や event は変えない
export function deleteMilestone(ctx: OpCtx, ref: string | number, projectId?: number): { id: number } {
  return tx(ctx.db, () => {
    const row = resolveMilestone(ctx.db, ref, projectId);
    if (projectId !== undefined && row.project_id !== projectId) throw new NodError("NOT_FOUND", `Milestone ${ref} はこの Project にありません`);
    ctx.db.query("DELETE FROM milestones WHERE id = ?").run(row.id);
    return { id: row.id };
  });
}
