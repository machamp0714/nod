import type { Database } from "bun:sqlite";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { loadDocuments, selectIssues } from "../issue-query";
import { PROJECT_STATUSES, type Project, type ProjectDetail, type ProjectStatus, type ProjectSummary, type UpdateProjectInput } from "../types";

export function resolveProject(db: Database, ref: string): { id: number; name: string } {
  const row = (
    /^\d+$/.test(ref)
      ? db.query("SELECT id, name FROM projects WHERE id = ?").get(Number(ref))
      : db.query("SELECT id, name FROM projects WHERE name = ?").get(ref)
  ) as { id: number; name: string } | null;
  if (!row) throw new NodError("NOT_FOUND", `Project ${ref} はありません`);
  return row;
}

interface ProjectRow {
  id: number;
  name: string;
  description: string | null;
  status: ProjectStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface SummaryRow extends ProjectRow {
  total: number;
  done: number;
  working: number;
  awaiting_input: number;
  awaiting_review: number;
  error: number;
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toSummary(r: SummaryRow): ProjectSummary {
  return {
    ...toProject(r),
    total: r.total,
    done: r.done,
    agents: { working: r.working, awaitingInput: r.awaiting_input, awaitingReview: r.awaiting_review, error: r.error },
  };
}

const open = "i.project_id = p.id AND i.archived_at IS NULL AND i.status NOT IN ('done', 'canceled')";
const SUMMARY_SELECT = `SELECT p.*,
  (SELECT count(*) FROM issues i WHERE i.project_id = p.id AND i.archived_at IS NULL AND i.status <> 'canceled') AS total,
  (SELECT count(*) FROM issues i WHERE i.project_id = p.id AND i.archived_at IS NULL AND i.status = 'done') AS done,
  (SELECT count(*) FROM issues i WHERE ${open} AND i.agent_state = 'working') AS working,
  (SELECT count(*) FROM issues i WHERE ${open} AND i.agent_state = 'awaiting_input') AS awaiting_input,
  (SELECT count(*) FROM issues i WHERE i.project_id = p.id AND i.archived_at IS NULL AND i.status = 'in_review') AS awaiting_review,
  (SELECT count(*) FROM issues i WHERE ${open} AND i.agent_state = 'error') AS error
FROM projects p`;

export function createProject(ctx: OpCtx, input: { name: string; description?: string }): Project {
  if (!input.name.trim()) throw new NodError("INVALID_ARGS", "Project の名前を指定してください");
  if (/^\d+$/.test(input.name)) {
    throw new NodError("INVALID_ARGS", `Project の名前に数字だけ（${input.name}）は使えません。数字は ID として解釈されるためです`);
  }
  return tx(ctx.db, () => {
    if (ctx.db.query("SELECT 1 FROM projects WHERE name = ?").get(input.name)) {
      throw new NodError("PROJECT_EXISTS", `Project ${input.name} はすでにあります`);
    }
    const ts = now();
    const { lastInsertRowid } = ctx.db
      .query("INSERT INTO projects (name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.name, input.description ?? null, ctx.actor, ts, ts);
    return toProject(ctx.db.query("SELECT * FROM projects WHERE id = ?").get(Number(lastInsertRowid)) as ProjectRow);
  });
}

export function updateProject(ctx: OpCtx, ref: string, input: UpdateProjectInput): Project {
  if (!(PROJECT_STATUSES as readonly unknown[]).includes(input.status)) {
    throw new NodError("INVALID_ARGS", `Project のステータスは ${PROJECT_STATUSES.join(", ")} で指定してください`);
  }
  return tx(ctx.db, () => {
    const { id } = resolveProject(ctx.db, ref);
    const row = ctx.db.query("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow;
    if (row.status === input.status) return toProject(row);
    const ts = now();
    ctx.db.query("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?").run(input.status, ts, id);
    return toProject({ ...row, status: input.status, updated_at: ts });
  });
}

export function listProjects(db: Database, opts: { includeClosed?: boolean } = {}): ProjectSummary[] {
  const where = opts.includeClosed ? "" : "WHERE p.status NOT IN ('completed', 'canceled')";
  return (db.query(`${SUMMARY_SELECT} ${where} ORDER BY p.name`).all() as SummaryRow[]).map(toSummary);
}

export function getProject(db: Database, ref: string): ProjectDetail {
  const { id } = resolveProject(db, ref);
  const row = db.query(`${SUMMARY_SELECT} WHERE p.id = ?`).get(id) as SummaryRow;
  return {
    ...toSummary(row),
    issues: selectIssues(db, "WHERE i.project_id = ? AND i.archived_at IS NULL ORDER BY w.key, i.number", [id]),
    documents: loadDocuments(db, { projectId: id }),
  };
}
