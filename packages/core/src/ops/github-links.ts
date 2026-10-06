import type { Database } from "bun:sqlite";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { recordEvent } from "../events";
import { findIssueRow, formatIssueId, type IssueRow } from "../issue-query";
import { githubRepoOfWorkspace } from "./github-repo";
import { type GhRunner, ghRunner } from "./pr-status";

// nod の Issue と GitHub Issue の対応（issue_imports を流用）と、送信の試行（github_publishes）の読み出し、紐付け、解除。
// 対応は nod 側にだけ残し、GitHub には印を書かない。解除は行を消さず issue_id を NULL にする（import が取り込み直さないため）
export const GITHUB_API_TIMEOUT_MS = 15_000;
export const GITHUB_SENDING_STALE_MS = 60_000; // 作成の POST のタイムアウト 30 秒 + 猶予 30 秒

export type GithubLinkOrigin = "import" | "publish" | "link";

export interface GithubLink {
  repo: string;
  number: number;
  url: string;
  origin: GithubLinkOrigin;
}

export interface GithubPendingAttempt {
  attemptId: string;
  state: "sending" | "unknown";
  repo: string; // 試行で固定した宛先。unknown の復旧はこの repo で確かめる
  startedAt: string;
  error: string | null;
}

export interface GithubIssueState {
  issueId: string;
  link: GithubLink | null;
  pending: GithubPendingAttempt | null;
  published: boolean; // 作成に成功した試行がある（紐付けを外しても再公開しない）
}

const ISSUE_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)\/(issues|pull)\/(\d+)\/?$/i;

export function parseGithubIssueUrl(url: string): { repo: string; number: number } {
  const m = ISSUE_URL_RE.exec(url.trim());
  if (!m) throw new NodError("INVALID_ARGS", `${url} は GitHub Issue の URL ではありません（例: https://github.com/owner/repo/issues/12）`);
  if ((m[3] ?? "").toLowerCase() === "pull") throw new NodError("INVALID_ARGS", "PR は紐付けられません。GitHub Issue の URL を指定してください");
  const number = Number(m[4]);
  if (!Number.isSafeInteger(number) || number < 1) throw new NodError("INVALID_ARGS", `${url} の番号を読めません`);
  return { repo: `${m[1]}/${m[2]}`.toLowerCase(), number };
}

export const sourceKeyOf = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
export const githubIssueUrl = (repo: string, number: number) => `https://github.com/${repo}/issues/${number}`;

function parseSourceKey(key: string): { repo: string; number: number } {
  const i = key.lastIndexOf("#");
  return { repo: key.slice(0, i), number: Number(key.slice(i + 1)) };
}

export function githubLinkOf(db: Database, issueRowId: number): GithubLink | null {
  const row = db
    .query("SELECT source_key, origin FROM issue_imports WHERE source = 'github' AND issue_id = ?")
    .get(issueRowId) as { source_key: string; origin: GithubLinkOrigin } | null;
  if (!row) return null;
  const { repo, number } = parseSourceKey(row.source_key);
  return { repo, number, url: githubIssueUrl(repo, number), origin: row.origin };
}

export function pendingAttemptOf(db: Database, issueRowId: number, nowMs = Date.now()): GithubPendingAttempt | null {
  const row = db
    .query("SELECT attempt_id, state, repo, started_at, error FROM github_publishes WHERE issue_id = ? AND state IN ('sending', 'unknown')")
    .get(issueRowId) as { attempt_id: string; state: "sending" | "unknown"; repo: string; started_at: string; error: string | null } | null;
  if (!row) return null;
  // プロセスが落ちて sending のまま残った試行は、結果が分からないものとして扱う
  const stale = row.state === "sending" && Date.parse(row.started_at) + GITHUB_SENDING_STALE_MS < nowMs;
  return {
    attemptId: row.attempt_id,
    state: stale ? "unknown" : row.state,
    repo: row.repo,
    startedAt: row.started_at,
    error: stale ? "送信中のまま応答がありませんでした" : row.error,
  };
}

export function hasSentAttempt(db: Database, issueRowId: number): boolean {
  return db.query("SELECT 1 FROM github_publishes WHERE issue_id = ? AND state = 'sent'").get(issueRowId) !== null;
}

export function githubStateOfRow(db: Database, row: IssueRow): GithubIssueState {
  return {
    issueId: formatIssueId(row.ws_key, row.number),
    link: githubLinkOf(db, row.id),
    pending: pendingAttemptOf(db, row.id),
    published: hasSentAttempt(db, row.id),
  };
}

export function getGithubState(db: Database, ref: string): GithubIssueState {
  return githubStateOfRow(db, findIssueRow(db, ref));
}

export function ghAuthFailed(stderr: string, exitCode: number): boolean {
  return exitCode === 4 || /gh auth login|not logged in|authentication required|bad credentials/i.test(stderr);
}

function pendingError(id: string): NodError {
  return new NodError("GITHUB_PUBLISH_PENDING", `${id} は GitHub に送信中です。終わってから実行してください`);
}

// gh で GitHub Issue の実在を確かめる（読み取りのみ）。PR と、移管などで repo・番号が変わったものは拒否する
async function verifyGithubIssue(run: GhRunner, repo: string, number: number): Promise<void> {
  const r = await run(["api", "--hostname", "github.com", `repos/${repo}/issues/${number}`], { timeoutMs: GITHUB_API_TIMEOUT_MS, maxStdoutBytes: 5 * 1024 * 1024 });
  if (r.kind === "not_found") throw new NodError("GH_NOT_INSTALLED", "gh が見つかりません。GitHub CLI を導入してください");
  if (r.kind !== "exited") throw new NodError("GH_FAILED", "GitHub Issue を確かめられませんでした（gh が時間内に終わらないか、出力が大きすぎます）");
  if (r.exitCode !== 0) {
    if (/HTTP 404/.test(r.stderr)) throw new NodError("NOT_FOUND", `GitHub Issue ${repo}#${number} が見つかりません`);
    if (ghAuthFailed(r.stderr, r.exitCode)) throw new NodError("GH_AUTH", "gh が未認証です。gh auth login を実行してください");
    throw new NodError("GH_FAILED", `GitHub Issue を確かめられませんでした: ${r.stderr.trim().split("\n")[0]?.slice(0, 200) ?? ""}`);
  }
  let data: { number?: unknown; html_url?: unknown; pull_request?: unknown };
  try {
    data = JSON.parse(r.stdout);
  } catch {
    throw new NodError("GH_FAILED", "gh の出力を読めませんでした");
  }
  if (data.pull_request) throw new NodError("INVALID_ARGS", "PR は紐付けられません。GitHub Issue の URL を指定してください");
  const actual = typeof data.html_url === "string" ? data.html_url : "";
  if (data.number !== number || actual.toLowerCase() !== githubIssueUrl(repo, number).toLowerCase()) {
    throw new NodError("INVALID_ARGS", `GitHub Issue の URL が変わっています（${actual || "不明"}）。新しい URL で紐付けてください`);
  }
}

export async function linkGithubIssue(ctx: OpCtx, ref: string, url: string, run: GhRunner = ghRunner): Promise<GithubIssueState> {
  if (isLlm(ctx)) throw new NodError("FORBIDDEN_FOR_LLM", "LLM は GitHub Issue を紐付けられません。紐付けは me に依頼してください");
  const target = parseGithubIssueUrl(url);
  const row = findIssueRow(ctx.db, ref);
  const id = formatIssueId(row.ws_key, row.number);
  const pending = pendingAttemptOf(ctx.db, row.id);
  if (pending?.state === "sending") throw pendingError(id);
  // 結果不明の復旧では、今の公開先ではなく、その試行で固定した repo で確かめる
  const expected = pending?.state === "unknown" ? pending.repo : githubRepoOfWorkspace(ctx.db, row.workspace_id);
  if (!expected) throw new NodError("GITHUB_REPO_NOT_SET", "公開先が未設定です。nod workspace github set <owner/repo> で設定してください");
  if (target.repo !== expected) throw new NodError("INVALID_ARGS", `宛先 ${expected} の Issue ではありません（${target.repo}）`);
  await verifyGithubIssue(run, target.repo, target.number);
  return tx(ctx.db, () => {
    const current = findIssueRow(ctx.db, ref);
    const latest = pendingAttemptOf(ctx.db, current.id);
    if (latest?.state === "sending") throw pendingError(id);
    const key = sourceKeyOf(target.repo, target.number);
    const link = githubLinkOf(ctx.db, current.id);
    const fullUrl = githubIssueUrl(target.repo, target.number);
    if (link && sourceKeyOf(link.repo, link.number) !== key) {
      throw new NodError("GITHUB_ALREADY_LINKED", `${id} はすでに ${link.url} に紐付いています。付け直すときは nod issue unlink-github ${id} で外してください`);
    }
    if (!link) {
      const existing = ctx.db
        .query(
          `SELECT m.id, m.issue_id, m.origin, w.key AS ws_key, i.number FROM issue_imports m
           LEFT JOIN issues i ON i.id = m.issue_id LEFT JOIN workspaces w ON w.id = i.workspace_id
           WHERE m.workspace_id = ? AND m.source = 'github' AND m.source_key = ?`,
        )
        .get(current.workspace_id, key) as { id: number; issue_id: number | null; origin: GithubLinkOrigin; ws_key: string | null; number: number | null } | null;
      if (existing?.issue_id != null && existing.ws_key && existing.number !== null) {
        const other = formatIssueId(existing.ws_key, existing.number);
        throw new NodError("GITHUB_LINK_CONFLICT", `${fullUrl} はすでに ${other} に紐付いています。nod issue unlink-github ${other} で外してから紐付けてください`, { linkedTo: other });
      }
      if (existing) {
        ctx.db.query("UPDATE issue_imports SET issue_id = ?, origin = 'link', imported_by = ?, imported_at = ? WHERE id = ?").run(current.id, ctx.actor, now(), existing.id);
      } else {
        ctx.db
          .query("INSERT INTO issue_imports (workspace_id, source, source_key, issue_id, imported_by, imported_at, origin) VALUES (?, 'github', ?, ?, ?, ?, 'link')")
          .run(current.workspace_id, key, current.id, ctx.actor, now());
      }
      const data: Record<string, unknown> = { url: fullUrl, origin: "link" };
      if (existing) data.previous_origin = existing.origin;
      if (latest) data.resolved_attempt = latest.attemptId;
      recordEvent(ctx.db, current.id, ctx.actor, "github_linked", data);
    }
    if (latest) {
      ctx.db
        .query("UPDATE github_publishes SET state = 'sent', result_number = ?, result_url = ?, finished_at = ? WHERE attempt_id = ? AND state IN ('sending', 'unknown')")
        .run(target.number, fullUrl, now(), latest.attemptId);
    }
    return githubStateOfRow(ctx.db, current);
  });
}

export function unlinkGithubIssue(ctx: OpCtx, ref: string): GithubIssueState {
  if (isLlm(ctx)) throw new NodError("FORBIDDEN_FOR_LLM", "LLM は GitHub Issue の紐付けを外せません。解除は me に依頼してください");
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    const id = formatIssueId(row.ws_key, row.number);
    if (pendingAttemptOf(ctx.db, row.id)?.state === "sending") throw pendingError(id);
    const link = githubLinkOf(ctx.db, row.id);
    if (!link) throw new NodError("NOT_FOUND", `${id} は GitHub Issue に紐付いていません`);
    ctx.db.query("UPDATE issue_imports SET issue_id = NULL WHERE source = 'github' AND issue_id = ?").run(row.id);
    recordEvent(ctx.db, row.id, ctx.actor, "github_unlinked", { url: link.url, origin: link.origin });
    return githubStateOfRow(ctx.db, row);
  });
}
