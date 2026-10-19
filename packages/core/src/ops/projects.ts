import type { Database, SQLQueryBindings } from "bun:sqlite";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { formatIssueId, loadDocuments, OPEN_BLOCKER, READY_UNLESS_BLOCKED_WHERE, selectIssues } from "../issue-query";
import { selectMilestones } from "./milestones";
import { PROJECT_HEALTH_CLEAR, PROJECT_HEALTHS, PROJECT_STATUSES, type Project, type ProjectHealth, type ProjectDetail, type ProjectFlow, type ProjectFlowEdge, type ProjectStatus, type ProjectSummary, type ProjectUpdate, type Status, type UpdateProjectInput } from "../types";

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
// 代わりに、大文字小文字を問わず名前に含むものを候補として案内する（#176）。
// 候補は 完全一致 → 前方一致 → 部分一致 の順に並べてから切る（大文字小文字だけが違う名前を、上限で落とさないため）
function projectNotFound(db: Database, ref: string): NodError {
  const needle = ref.trim().toLowerCase();
  const rank = (name: string): number => (name === needle ? 0 : name.startsWith(needle) ? 1 : 2);
  // SQLite の lower は非ASCIIを畳まないので、Issue の検索と同じく JavaScript で比べる
  const candidates = needle
    ? (db.query("SELECT id, name FROM projects ORDER BY name, id").all() as { id: number; name: string }[])
        .filter((p) => p.name.toLowerCase().includes(needle))
        .sort((a, b) => rank(a.name.toLowerCase()) - rank(b.name.toLowerCase()))
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
    agents: { working: r.working, awaitingInput: r.awaiting_input, error: r.error },
  };
}

const open = "i.project_id = p.id AND i.archived_at IS NULL AND i.status NOT IN ('done', 'canceled')";
const SUMMARY_SELECT = `SELECT p.*,
  (SELECT u.health FROM project_updates u WHERE u.project_id = p.id AND (u.health IS NOT NULL OR u.health_cleared = 1) ORDER BY u.created_at DESC, u.id DESC LIMIT 1) AS health,
  (SELECT count(*) FROM issues i WHERE i.project_id = p.id AND i.archived_at IS NULL AND i.status <> 'canceled') AS total,
  (SELECT count(*) FROM issues i WHERE i.project_id = p.id AND i.archived_at IS NULL AND i.status = 'done') AS done,
  (SELECT count(*) FROM issues i WHERE ${open} AND i.agent_state = 'working') AS working,
  (SELECT count(*) FROM issues i WHERE ${open} AND i.agent_state = 'awaiting_input') AS awaiting_input,
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

interface FlowNodeRow {
  issue_id: number;
  ws_key: string;
  ws_name: string;
  number: number;
  title: string;
  status: Status;
  project_id: number | null;
  project_name: string | null;
  ready_unless_blocked: number;
}

// Project の依存フロー。Issue 詳細を1件ずつ読まず、ノード・まだ止めているブロック元・辺をそれぞれ1回の読み取りで返す
export function getProjectFlow(db: Database, ref: string): ProjectFlow {
  const { id } = resolveProject(db, ref);
  // 先に Project の Issue（members）と、それと直接 blocks でつながる Issue（targets）の集合を作り、
  // Project と無関係な Issue ごとに relations を読まない。relations には to_id の索引がないため、
  // 後ろ向き（to_id）の辺は Issue ごとに引かず、1回の読み取りでまとめて引く。前向きの辺は主キー（from_id 始まり）で引く
  const members = `members AS (SELECT id FROM issues WHERE project_id = ? AND archived_at IS NULL)`;
  const links = `links AS (
    SELECT r.from_id, r.to_id FROM members m JOIN relations r ON r.from_id = m.id WHERE r.type = 'blocks'
    UNION SELECT r.from_id, r.to_id FROM relations r WHERE r.type = 'blocks' AND r.to_id IN (SELECT id FROM members)
  )`;
  const targets = `targets AS (SELECT id FROM members UNION SELECT from_id FROM links UNION SELECT to_id FROM links)`;
  // 主ノード（Project 内）と参照ノード（Project 外）。アーカイブ済みは両端とも除く
  const rows = db
    .query(
      `WITH ${members}, ${links}, ${targets}
       SELECT i.id AS issue_id, w.key AS ws_key, w.name AS ws_name, i.number, i.title, i.status, i.project_id, pr.name AS project_name,
         ${READY_UNLESS_BLOCKED_WHERE} AS ready_unless_blocked
       FROM targets t
       JOIN issues i ON i.id = t.id
       JOIN workspaces w ON w.id = i.workspace_id
       LEFT JOIN projects pr ON pr.id = i.project_id
       WHERE i.archived_at IS NULL
       ORDER BY i.project_id IS NOT ?, w.key, i.number`,
    )
    .all(id, now(), id) as FlowNodeRow[]; // ? の順：主ノード、READY_UNLESS_BLOCKED_WHERE の現在時刻、並び順
  // ノードをまだ止めているブロック元（Issue.blockedBy と同じ）。Project 外のブロック元も含める。
  // relations を1回だけ読み、ノードごとの読み取りにしない
  const blockers = db
    .query(
      `WITH ${members}, ${links}, ${targets}
       SELECT r.to_id, bw.key || '-' || b.number AS blocker_id FROM relations r
       JOIN issues b ON b.id = r.from_id JOIN workspaces bw ON bw.id = b.workspace_id
       WHERE r.type = 'blocks' AND r.to_id IN (SELECT id FROM targets) AND ${OPEN_BLOCKER}
       ORDER BY bw.key, b.number`,
    )
    .all(id) as { to_id: number; blocker_id: string }[];
  const openBlockers = new Map<number, string[]>();
  for (const b of blockers) {
    const list = openBlockers.get(b.to_id);
    if (list) list.push(b.blocker_id);
    else openBlockers.set(b.to_id, [b.blocker_id]);
  }
  const nodes = rows.map((r) => {
    const blockedBy = openBlockers.get(r.issue_id) ?? [];
    return {
      id: formatIssueId(r.ws_key, r.number),
      title: r.title,
      status: r.status,
      workspace: r.ws_key,
      workspaceName: r.ws_name,
      project: r.project_id !== null && r.project_name !== null ? { id: r.project_id, name: r.project_name } : null,
      external: r.project_id !== id,
      // web の Ready（READY_WHERE）と同じ条件：ブロック元以外の条件を満たし、まだ止めているブロック元がない
      ready: r.ready_unless_blocked === 1 && blockedBy.length === 0,
      openBlockers: blockedBy,
    };
  });
  // 生の blocks の向きのまま返す（完了・中止のブロック元も辺に残す）。参照ノード同士の辺は含めない
  const edges = db
    .query(
      `WITH ${members}, ${links}
       SELECT fw.key || '-' || f.number AS "from", tw.key || '-' || t.number AS "to" FROM links r
       JOIN issues f ON f.id = r.from_id JOIN workspaces fw ON fw.id = f.workspace_id
       JOIN issues t ON t.id = r.to_id JOIN workspaces tw ON tw.id = t.workspace_id
       WHERE f.archived_at IS NULL AND t.archived_at IS NULL
       ORDER BY fw.key, f.number, tw.key, t.number`,
    )
    .all(id) as ProjectFlowEdge[];
  return { projectId: id, nodes, edges };
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
