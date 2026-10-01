import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { ORCA_AGENTS, type OrcaAgent, type Workspace } from "../types";
import { allocateWorkspaceColor } from "../workspace-colors";
import { removeStoredFiles, workspaceAttachmentPaths } from "./attachments";

export const KEY_RE = /^[A-Z0-9]{2,6}$/;

interface WorkspaceRow {
  id: number;
  key: string;
  name: string;
  path: string;
  color: string;
  default_agent: OrcaAgent;
  created_at: string;
}

function toWorkspace(r: WorkspaceRow): Workspace {
  return { id: r.id, key: r.key, name: r.name, path: r.path, color: r.color, defaultAgent: r.default_agent, createdAt: r.created_at };
}

export function deriveKey(repoName: string): string | null {
  const key = repoName
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 3)
    .toUpperCase();
  return KEY_RE.test(key) ? key : null;
}

export function parseOrcaAgent(value: string): OrcaAgent {
  if (!(ORCA_AGENTS as readonly string[]).includes(value)) {
    throw new NodError("INVALID_ARGS", `エージェントは ${ORCA_AGENTS.join("、")} のいずれかで指定してください（受け取った値: ${value}）`);
  }
  return value as OrcaAgent;
}

// 「Orca で作業を始める」（#210）の既定のエージェントを変える。ほかの Workspace 設定と同じく人だけが変えられる
export function setWorkspaceDefaultAgent(ctx: OpCtx, keyOrPath: string, agent: string): Workspace {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は既定のエージェントを変えられません。変更は me に依頼してください");
  }
  const value = parseOrcaAgent(agent);
  return tx(ctx.db, () => {
    const workspace = findWorkspace(ctx.db, keyOrPath);
    if (!workspace) throw new NodError("NOT_FOUND", `Workspace ${keyOrPath} は登録されていません`);
    ctx.db.query("UPDATE workspaces SET default_agent = ? WHERE id = ?").run(value, workspace.id);
    return { ...workspace, defaultAgent: value };
  });
}

export function listWorkspaces(db: Database): Workspace[] {
  return (db.query("SELECT * FROM workspaces ORDER BY key").all() as WorkspaceRow[]).map(toWorkspace);
}

export function findWorkspace(db: Database, keyOrPath: string): Workspace | null {
  const row = db.query("SELECT * FROM workspaces WHERE key = ? OR path = ?").get(keyOrPath.toUpperCase(), keyOrPath) as
    | WorkspaceRow
    | null;
  return row ? toWorkspace(row) : null;
}

export function initWorkspace(
  db: Database,
  input: { path: string; key?: string; name?: string },
): { workspace: Workspace; created: boolean } {
  return tx(db, () => {
    const existing = db.query("SELECT * FROM workspaces WHERE path = ?").get(input.path) as WorkspaceRow | null;
    if (existing) return { workspace: toWorkspace(existing), created: false };

    const name = input.name ?? basename(input.path);
    const key = input.key ? input.key.toUpperCase() : deriveKey(basename(input.path));
    if (!key || !KEY_RE.test(key)) {
      throw new NodError(
        "INVALID_ARGS",
        `Workspace のキーを決められません。--key で英大文字と数字の2〜6文字を指定してください（例: nod init --key API）`,
      );
    }
    const byKey = db.query("SELECT * FROM workspaces WHERE key = ?").get(key) as WorkspaceRow | null;
    if (byKey) {
      throw new NodError("KEY_TAKEN", `キー ${key} はすでに ${byKey.name} が使っています。--key で別のキーを指定してください`);
    }
    const byName = db.query("SELECT * FROM workspaces WHERE name = ?").get(name) as WorkspaceRow | null;
    if (byName) {
      throw new NodError("NAME_TAKEN", `名前 ${name} はすでに ${byName.path} が使っています。--name で別の名前を指定してください`);
    }
    const used = db.query("SELECT color FROM workspaces").all() as { color: string }[];
    const color = allocateWorkspaceColor(new Set(used.map((row) => row.color)));
    const { lastInsertRowid } = db
      .query("INSERT INTO workspaces (key, name, path, created_at, color) VALUES (?, ?, ?, ?, ?)")
      .run(key, name, input.path, now(), color);
    const row = db.query("SELECT * FROM workspaces WHERE id = ?").get(Number(lastInsertRowid)) as WorkspaceRow;
    return { workspace: toWorkspace(row), created: true };
  });
}

export function countIssues(db: Database, workspaceId: number): number {
  return (db.query("SELECT count(*) AS n FROM issues WHERE workspace_id = ?").get(workspaceId) as { n: number }).n;
}

// attachmentsDir は添付ファイルのコピーを置く場所。省くと defaultAttachmentsDir()
export function removeWorkspace(
  db: Database,
  keyOrPath: string,
  attachmentsDir?: string,
): { workspace: Workspace; deletedIssues: number } {
  const { files, ...result } = tx(db, () => {
    const workspace = findWorkspace(db, keyOrPath);
    if (!workspace) throw new NodError("NOT_FOUND", `Workspace ${keyOrPath} は登録されていません`);
    const deletedIssues = countIssues(db, workspace.id);
    // cascade で消える添付の実体は、行が消えた後（commit 後）に消す
    const files = workspaceAttachmentPaths(db, workspace.id);
    db.query("DELETE FROM workspaces WHERE id = ?").run(workspace.id);
    return { workspace, deletedIssues, files };
  });
  removeStoredFiles(files, attachmentsDir);
  return result;
}
