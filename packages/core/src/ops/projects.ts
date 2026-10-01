import type { Database, SQLQueryBindings } from "bun:sqlite";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { loadDocuments, selectIssues } from "../issue-query";
import { selectMilestones } from "./milestones";
import { PROJECT_HEALTH_CLEAR, PROJECT_HEALTHS, PROJECT_STATUSES, type Project, type ProjectHealth, type ProjectDetail, type ProjectStatus, type ProjectSummary, type ProjectUpdate, type UpdateProjectInput } from "../types";

export function resolveProject(db: Database, ref: string): { id: number; name: string } {
  const row = (
    /^\d+$/.test(ref)
      ? db.query("SELECT id, name FROM projects WHERE id = ?").get(Number(ref))
      : db.query("SELECT id, name FROM projects WHERE name = ?").get(ref)
  ) as { id: number; name: string } | null;
  if (!row) throw projectNotFound(db, ref);
  return row;
}

const PROJECT_CANDIDATE_LIMIT = 5;

// 名前の一部しか合わない指定は解決しない（意図しない Project に書き込まないため）。
// 代わりに、大文字小文字を問わず名前に含むものを候補として案内する（#176）
function projectNotFound(db: Database, ref: string): NodError {
  const needle = ref.trim().toLowerCase();
  // SQLite の lower は非ASCIIを畳まないので、Issue の検索と同じく JavaScript で比べる
  const candidates = needle
    ? (db.query("SELECT id, name FROM projects ORDER BY name, id").all() as { id: number; name: string }[])
        .filter((p) => p.name.toLowerCase().includes(needle))
        .slice(0, PROJECT_CANDIDATE_LIMIT)
    : [];
  const hint = candidates.length
    ? `近い名前: ${candidates.map((p) => `${p.name}（ID ${p.id}）`).join("、")}。名前の全体か ID で指定してください`
    : "nod project list で名前と ID を確かめてください";
  return new NodError("NOT_FOUND", `Project ${ref} はありません。${hint}`, candidates.length ? { candidates } : undefined);
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
  (SELECT u.health FROM project_updates u WHERE u.project_id = p.id AND (u.health IS NOT NULL OR u.health_cleared = 1) ORDER BY u.created_at DESC, u.id DESC LIMIT 1) AS health,
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

// Project の一覧・詳細と同じ集計で、条件に合う Project を返す。p は projects の別名
export function selectProjectSummaries(db: Database, where: string, params: SQLQueryBindings[]): ProjectSummary[] {
  return (db.query(`${SUMMARY_SELECT} ${where}`).all(...params) as SummaryRow[]).map(toSummary);
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
    milestones: selectMilestones(db, id),
    issues: selectIssues(db, "WHERE i.project_id = ? AND i.archived_at IS NULL ORDER BY w.key, i.number", [id]),
    documents: loadDocuments(db, { projectId: id }),
    updates: selectProjectUpdates(db, id),
    initiatives: db
      .query(
        `SELECT n.id, n.name FROM initiative_projects ip JOIN initiatives n ON n.id = ip.initiative_id
         WHERE ip.project_id = ? ORDER BY n.name`,
      )
      .all(id) as { id: number; name: string }[],
  };
}

export const PROJECT_UPDATE_MAX_LENGTH = 10000;

interface ProjectUpdateRow {
  id: number;
  project_id: number;
  author: string;
  body: string;
  health: ProjectHealth | null;
  health_cleared: number;
  created_at: string;
}

function toProjectUpdate(r: ProjectUpdateRow): ProjectUpdate {
  return {
    id: r.id,
    projectId: r.project_id,
    author: r.author,
    body: r.body,
    health: r.health,
    healthCleared: r.health_cleared === 1,
    createdAt: r.created_at,
  };
}

function selectProjectUpdates(db: Database, projectId: number): ProjectUpdate[] {
  return (
    db.query("SELECT * FROM project_updates WHERE project_id = ? ORDER BY created_at DESC, id DESC").all(projectId) as ProjectUpdateRow[]
  ).map(toProjectUpdate);
}

// 進捗報告を追記する。健全性は任意で、添えたときだけ現在の健全性が変わる（"none" は未設定に戻す）。Project の状態・updated_at と所属 Issue には触れない
export function addProjectUpdate(
  ctx: OpCtx,
  ref: string,
  body: string,
  health: ProjectHealth | typeof PROJECT_HEALTH_CLEAR | null = null,
): ProjectUpdate {
  if (typeof body !== "string" || !body.trim()) throw new NodError("INVALID_ARGS", "進捗報告の本文を指定してください");
  if (body.length > PROJECT_UPDATE_MAX_LENGTH) {
    throw new NodError("INVALID_ARGS", `進捗報告の本文は ${PROJECT_UPDATE_MAX_LENGTH} 文字以内にしてください（${body.length} 文字）`);
  }
  if (health !== null && health !== PROJECT_HEALTH_CLEAR && !(PROJECT_HEALTHS as readonly unknown[]).includes(health)) {
    throw new NodError(
      "INVALID_ARGS",
      `Project の健全性は ${PROJECT_HEALTHS.join(", ")} か、未設定に戻す ${PROJECT_HEALTH_CLEAR} で指定してください`,
    );
  }
  const cleared = health === PROJECT_HEALTH_CLEAR;
  return tx(ctx.db, () => {
    const { id } = resolveProject(ctx.db, ref);
    const { lastInsertRowid } = ctx.db
      .query("INSERT INTO project_updates (project_id, author, body, health, health_cleared, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, ctx.actor, body, cleared ? null : health, cleared ? 1 : 0, now());
    return toProjectUpdate(ctx.db.query("SELECT * FROM project_updates WHERE id = ?").get(Number(lastInsertRowid)) as ProjectUpdateRow);
  });
}

export function listProjectUpdates(db: Database, ref: string): ProjectUpdate[] {
  return selectProjectUpdates(db, resolveProject(db, ref).id);
}
