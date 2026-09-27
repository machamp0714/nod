import type { Database } from "bun:sqlite";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { loadDocuments, selectIssues } from "../issue-query";
import type { Project, ProjectDetail, ProjectStatus, ProjectSummary } from "../types";

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
    agents: { working: r.working, awaitingInput: r.awaiting_input, error: r.error },
  };
}

const open = "i.project_id = p.id AND i.status NOT IN ('done', 'canceled')";
const SUMMARY_SELECT = `SELECT p.*,
  (SELECT count(*) FROM issues i WHERE i.project_id = p.id AND i.status <> 'canceled') AS total,
  (SELECT count(*) FROM issues i WHERE i.project_id = p.id AND i.status = 'done') AS done,
  (SELECT count(*) FROM issues i WHERE ${open} AND i.agent_state = 'working') AS working,
  (SELECT count(*) FROM issues i WHERE ${open} AND i.agent_state = 'awaiting_input') AS awaiting_input,
  (SELECT count(*) FROM issues i WHERE ${open} AND i.agent_state = 'error') AS error
FROM projects p`;

export function createProject(ctx: OpCtx, input: { name: string; description?: string }): Project {
  if (!input.name.trim()) throw new NodError("INVALID_ARGS", "Project の名前を指定してください");
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

export function listProjects(db: Database, opts: { includeClosed?: boolean } = {}): ProjectSummary[] {
  const where = opts.includeClosed ? "" : "WHERE p.status NOT IN ('completed', 'canceled')";
  return (db.query(`${SUMMARY_SELECT} ${where} ORDER BY p.name`).all() as SummaryRow[]).map(toSummary);
}

export function getProject(db: Database, ref: string): ProjectDetail {
  const { id } = resolveProject(db, ref);
  const row = db.query(`${SUMMARY_SELECT} WHERE p.id = ?`).get(id) as SummaryRow;
  return {
    ...toSummary(row),
    issues: selectIssues(db, "WHERE i.project_id = ? ORDER BY w.key, i.number", [id]),
    documents: loadDocuments(db, { projectId: id }),
  };
}
