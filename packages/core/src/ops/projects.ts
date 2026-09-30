import type { Database } from "bun:sqlite";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { loadDocuments, selectIssues } from "../issue-query";
import { PROJECT_HEALTHS, PROJECT_STATUSES, type Project, type ProjectHealth, type ProjectDetail, type ProjectStatus, type ProjectSummary, type ProjectUpdate, type UpdateProjectInput } from "../types";

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
  health: ProjectHealth | null;
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
    health: r.health,
    total: r.total,
    done: r.done,
    agents: { working: r.working, awaitingInput: r.awaiting_input, awaitingReview: r.awaiting_review, error: r.error },
  };
}

const open = "i.project_id = p.id AND i.archived_at IS NULL AND i.status NOT IN ('done', 'canceled')";
const SUMMARY_SELECT = `SELECT p.*,
  (SELECT u.health FROM project_updates u WHERE u.project_id = p.id AND u.health IS NOT NULL ORDER BY u.created_at DESC, u.id DESC LIMIT 1) AS health,
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
    updates: selectProjectUpdates(db, id),
  };
}

export const PROJECT_UPDATE_MAX_LENGTH = 10000;

interface ProjectUpdateRow {
  id: number;
  project_id: number;
  author: string;
  body: string;
  health: ProjectHealth | null;
  created_at: string;
}

function toProjectUpdate(r: ProjectUpdateRow): ProjectUpdate {
  return { id: r.id, projectId: r.project_id, author: r.author, body: r.body, health: r.health, createdAt: r.created_at };
}

function selectProjectUpdates(db: Database, projectId: number): ProjectUpdate[] {
  return (
    db.query("SELECT * FROM project_updates WHERE project_id = ? ORDER BY created_at DESC, id DESC").all(projectId) as ProjectUpdateRow[]
  ).map(toProjectUpdate);
}

// 進捗報告を追記する。健全性は任意で、添えたときだけ現在の健全性が変わる。Project の状態・updated_at と所属 Issue には触れない
export function addProjectUpdate(ctx: OpCtx, ref: string, body: string, health: ProjectHealth | null = null): ProjectUpdate {
  if (typeof body !== "string" || !body.trim()) throw new NodError("INVALID_ARGS", "進捗報告の本文を指定してください");
  if (body.length > PROJECT_UPDATE_MAX_LENGTH) {
    throw new NodError("INVALID_ARGS", `進捗報告の本文は ${PROJECT_UPDATE_MAX_LENGTH} 文字以内にしてください（${body.length} 文字）`);
  }
  if (health !== null && !(PROJECT_HEALTHS as readonly unknown[]).includes(health)) {
    throw new NodError("INVALID_ARGS", `Project の健全性は ${PROJECT_HEALTHS.join(", ")} で指定してください`);
  }
  return tx(ctx.db, () => {
    const { id } = resolveProject(ctx.db, ref);
    const { lastInsertRowid } = ctx.db
      .query("INSERT INTO project_updates (project_id, author, body, health, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, ctx.actor, body, health, now());
    return toProjectUpdate(ctx.db.query("SELECT * FROM project_updates WHERE id = ?").get(Number(lastInsertRowid)) as ProjectUpdateRow);
  });
}

export function listProjectUpdates(db: Database, ref: string): ProjectUpdate[] {
  return selectProjectUpdates(db, resolveProject(db, ref).id);
}
