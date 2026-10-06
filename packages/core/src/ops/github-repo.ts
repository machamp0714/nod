// packages/core/src/ops/github-repo.ts
import type { Database } from "bun:sqlite";
import { isLlm, now, type OpCtx } from "../ctx";
import { NodError } from "../errors";
import type { GhRunner } from "./pr-status";
import { findWorkspace } from "./workspaces";

// nod の Issue を GitHub Issue として作成するときの公開先（Workspace ごと）と、git の origin の読み取り。
// 対応表（issue_imports）のキーと比べるため、repo は小文字の owner/repo で持つ

// owner は英数字とハイフン、repo は英数字と . _ -。先頭の - は gh のオプションと取り違えるので認めない
export const GITHUB_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._][A-Za-z0-9._-]*$/;
export const ORIGIN_TIMEOUT_MS = 15_000;

export type OriginMissReason = "no_origin" | "unparsable" | "other_host";
export type OriginRepo = { repo: string; reason: null } | { repo: null; reason: OriginMissReason };

export interface WorkspaceGithubRepo {
  workspaceKey: string;
  repo: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface WorkspaceGithubRepoView extends WorkspaceGithubRepo {
  originCandidate: string | null; // 未設定のときだけ、origin から推定した候補
}

export function normalizeGithubRepo(input: string): string {
  const value = input.trim();
  if (!GITHUB_REPO_RE.test(value)) throw new NodError("INVALID_ARGS", `${input} は owner/repo の形ではありません（例: machamp0714/nod）`);
  return value.toLowerCase();
}

const HTTPS_RE = /^https:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const SSH_RE = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const SCP_RE = /^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

// GitHub の HTTPS・SSH・scp 形式の remote URL を owner/repo（小文字）にする。github.com 以外とホスト別名は推測しない
export function parseGithubRemote(url: string): OriginRepo {
  const u = url.trim();
  const m = HTTPS_RE.exec(u) ?? SSH_RE.exec(u) ?? SCP_RE.exec(u);
  if (!m) return { repo: null, reason: "unparsable" };
  if ((m[1] ?? "").toLowerCase() !== "github.com") return { repo: null, reason: "other_host" };
  const repo = `${m[2]}/${m[3]}`;
  return GITHUB_REPO_RE.test(repo) ? { repo: repo.toLowerCase(), reason: null } : { repo: null, reason: "unparsable" };
}

// path のリポジトリの origin を読む。git が失敗した（リポジトリでない、origin がない）ときは no_origin
export async function readOriginRepo(run: GhRunner, path: string): Promise<OriginRepo> {
  const r = await run(["-C", path, "remote", "get-url", "origin"], { timeoutMs: ORIGIN_TIMEOUT_MS });
  if (r.kind !== "exited" || r.exitCode !== 0) return { repo: null, reason: "no_origin" };
  return parseGithubRemote(r.stdout.trim());
}

function workspaceOrThrow(db: Database, keyOrPath: string) {
  const workspace = findWorkspace(db, keyOrPath);
  if (!workspace) throw new NodError("NOT_FOUND", `Workspace ${keyOrPath} は登録されていません`);
  return workspace;
}

export function getWorkspaceGithubRepo(db: Database, keyOrPath: string): WorkspaceGithubRepo {
  const workspace = workspaceOrThrow(db, keyOrPath);
  const row = db
    .query("SELECT github_repo, github_repo_updated_at, github_repo_updated_by FROM workspaces WHERE id = ?")
    .get(workspace.id) as { github_repo: string | null; github_repo_updated_at: string | null; github_repo_updated_by: string | null };
  return { workspaceKey: workspace.key, repo: row.github_repo, updatedAt: row.github_repo_updated_at, updatedBy: row.github_repo_updated_by };
}

export async function getWorkspaceGithubRepoView(db: Database, keyOrPath: string, git: GhRunner): Promise<WorkspaceGithubRepoView> {
  const current = getWorkspaceGithubRepo(db, keyOrPath);
  if (current.repo) return { ...current, originCandidate: null };
  const origin = await readOriginRepo(git, workspaceOrThrow(db, keyOrPath).path);
  return { ...current, originCandidate: origin.repo };
}

export function githubRepoOfWorkspace(db: Database, workspaceId: number): string | null {
  const row = db.query("SELECT github_repo FROM workspaces WHERE id = ?").get(workspaceId) as { github_repo: string | null } | null;
  return row?.github_repo ?? null;
}

function writeRepo(ctx: OpCtx, keyOrPath: string, repo: string | null): WorkspaceGithubRepo {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は GitHub の公開先を変えられません。変更は me に依頼してください");
  }
  const workspace = workspaceOrThrow(ctx.db, keyOrPath);
  ctx.db
    .query("UPDATE workspaces SET github_repo = ?, github_repo_updated_at = ?, github_repo_updated_by = ? WHERE id = ?")
    .run(repo, now(), ctx.actor, workspace.id);
  return getWorkspaceGithubRepo(ctx.db, workspace.key);
}

// 公開先を変えても、作成済みの対応と送信中の試行の宛先（github_publishes.repo）は変えない
export function setWorkspaceGithubRepo(ctx: OpCtx, keyOrPath: string, repo: string): WorkspaceGithubRepo {
  return writeRepo(ctx, keyOrPath, normalizeGithubRepo(repo));
}

export function clearWorkspaceGithubRepo(ctx: OpCtx, keyOrPath: string): WorkspaceGithubRepo {
  return writeRepo(ctx, keyOrPath, null);
}
