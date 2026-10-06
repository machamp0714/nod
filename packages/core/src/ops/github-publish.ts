import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { recordEvent } from "../events";
import { detectLeaks, type LeakFinding, leakConfigOf } from "../github-leak";
import { findIssueRow, formatIssueId, issueRowById, type IssueRow } from "../issue-query";
import { gitRunner } from "./git-sync";
import {
  GITHUB_API_TIMEOUT_MS,
  type GithubIssueState,
  ghAuthFailed,
  githubIssueUrl,
  githubLinkOf,
  githubStateOfRow,
  hasSentAttempt,
  parseGithubIssueUrl,
  pendingAttemptOf,
  sourceKeyOf,
} from "./github-links";
import { githubRepoOfWorkspace, normalizeGithubRepo, type OriginMissReason, readOriginRepo } from "./github-repo";
import { type GhRunner, type GhRunResult, ghRunner } from "./pr-status";

// nod の Issue を GitHub Issue として1回だけ作成する。送るのはタイトルと本文だけで、作成後の同期・更新・close・コメントはしない。
// 送信権は github_publishes の部分 UNIQUE で取り、外部の呼び出しの間は DB の transaction を持たない。
// 「必ず1回だけ作る」ことは保証しない（GitHub と SQLite を1つの transaction にできない）。結果が分からないときは再送せず、人の確認で復旧する
export const GITHUB_CREATE_TIMEOUT_MS = 30_000;
export const GITHUB_TITLE_MAX = 256;
export const GITHUB_BODY_MAX = 65_536;
// 作成を拒否したと確認できる HTTP の状態。これ以外の失敗は結果不明にする
const DEFINITE_REJECTIONS = [400, 401, 403, 404, 410, 422, 429];

export interface GithubPublishDeps {
  gh?: GhRunner;
  git?: GhRunner;
  webPort?: number;
  env?: Record<string, string | undefined>;
}

export interface GithubPublishBlocker {
  code: string;
  message: string;
}

export interface GithubPublishPreview {
  issueId: string;
  title: string; // nod のタイトル（送信用の既定値）
  body: string; // nod の本文（送信用の既定値）
  repo: string | null;
  repoCandidate: string | null; // 公開先が未設定のとき、origin から推定した候補
  repoCandidateReason: OriginMissReason | null;
  ghLogin: string | null;
  ghError: GithubPublishBlocker | null;
  findings: LeakFinding[];
  blockers: GithubPublishBlocker[];
  state: GithubIssueState;
}

export interface GithubPublishInput {
  title: string;
  body: string;
  repo: string; // 確認した宛先
  ghLogin: string; // 確認したアカウント
}

export interface GithubPublishResult {
  issueId: string;
  attemptId: string;
  repo: string;
  number: number;
  url: string;
  recorded: boolean; // nod に対応を記録できた
  message: string | null;
}

export type CreateOutcome =
  | { kind: "sent"; number: number; url: string; repo: string }
  | { kind: "failed"; code: string; message: string }
  | { kind: "unknown"; message: string };

const codePoints = (s: string) => Array.from(s).length;

function validateText(input: { title: string; body: string }): void {
  if (!input.title.trim()) throw new NodError("INVALID_ARGS", "タイトルを指定してください");
  if (codePoints(input.title) > GITHUB_TITLE_MAX) throw new NodError("INVALID_ARGS", `タイトルは ${GITHUB_TITLE_MAX} 文字までです`);
  if (codePoints(input.body) > GITHUB_BODY_MAX) throw new NodError("INVALID_ARGS", `本文は ${GITHUB_BODY_MAX} 文字までです`);
}

function leakError(findings: LeakFinding[]): NodError {
  return new NodError("LEAK_DETECTED", `nod の情報が ${findings.length} 件見つかったため送信しません。書き換えてから送ってください`, { findings });
}

function blockersOf(db: Database, row: IssueRow): GithubPublishBlocker[] {
  const id = formatIssueId(row.ws_key, row.number);
  const out: GithubPublishBlocker[] = [];
  if (row.archived_at) out.push({ code: "ISSUE_ARCHIVED", message: `${id} はアーカイブ済みのため公開できません` });
  if (row.status === "done" || row.status === "canceled") out.push({ code: "ISSUE_CLOSED", message: `${id} は ${row.status} のため公開できません` });
  const link = githubLinkOf(db, row.id);
  if (link) out.push({ code: "GITHUB_ALREADY_LINKED", message: `${id} はすでに ${link.url} に対応しています` });
  else if (hasSentAttempt(db, row.id)) {
    out.push({ code: "GITHUB_ALREADY_PUBLISHED", message: `${id} は一度 GitHub Issue を作成しています。紐付けを外しても再公開はできません（nod issue link-github で紐付け直せます）` });
  }
  const pending = pendingAttemptOf(db, row.id);
  if (pending?.state === "sending") out.push({ code: "GITHUB_PUBLISH_PENDING", message: `${id} は GitHub に送信中です` });
  if (pending?.state === "unknown") {
    out.push({
      code: "GITHUB_RESULT_UNKNOWN",
      message: `${id} の前回の作成は結果不明です。GitHub の ${pending.repo} を確かめ、作られていれば nod issue link-github ${id} <URL>、作られていなければ nod issue publish ${id} --clear-unknown で解除してください`,
    });
  }
  return out;
}

async function fetchLogin(run: GhRunner): Promise<{ login: string } | { error: GithubPublishBlocker }> {
  const r = await run(["api", "--hostname", "github.com", "user", "--jq", ".login"], { timeoutMs: GITHUB_API_TIMEOUT_MS, maxStdoutBytes: 64 * 1024 });
  if (r.kind === "not_found") return { error: { code: "GH_NOT_INSTALLED", message: "gh が見つかりません。GitHub CLI を導入してください" } };
  if (r.kind !== "exited") return { error: { code: "GH_FAILED", message: "gh のアカウントを確かめられませんでした" } };
  if (r.exitCode !== 0) {
    if (ghAuthFailed(r.stderr, r.exitCode)) return { error: { code: "GH_AUTH", message: "gh が未認証です。gh auth login を実行してください" } };
    return { error: { code: "GH_FAILED", message: `gh のアカウントを確かめられませんでした: ${r.stderr.trim().split("\n")[0]?.slice(0, 200) ?? ""}` } };
  }
  const login = r.stdout.trim();
  if (!/^[A-Za-z0-9-]+$/.test(login)) return { error: { code: "GH_FAILED", message: "gh のアカウント名を読めませんでした" } };
  return { login };
}

export async function previewGithubPublish(ctx: OpCtx, ref: string, deps: GithubPublishDeps = {}): Promise<GithubPublishPreview> {
  const row = findIssueRow(ctx.db, ref);
  const repo = githubRepoOfWorkspace(ctx.db, row.workspace_id);
  let repoCandidate: string | null = null;
  let repoCandidateReason: OriginMissReason | null = null;
  if (!repo) {
    const ws = ctx.db.query("SELECT path FROM workspaces WHERE id = ?").get(row.workspace_id) as { path: string };
    const origin = await readOriginRepo(deps.git ?? gitRunner, ws.path);
    repoCandidate = origin.repo;
    repoCandidateReason = origin.reason;
  }
  const login = await fetchLogin(deps.gh ?? ghRunner);
  const title = row.title;
  const body = row.description ?? "";
  return {
    issueId: formatIssueId(row.ws_key, row.number),
    title,
    body,
    repo,
    repoCandidate,
    repoCandidateReason,
    ghLogin: "login" in login ? login.login : null,
    ghError: "error" in login ? login.error : null,
    findings: detectLeaks({ title, body }, leakConfigOf(ctx.db, deps)),
    blockers: blockersOf(ctx.db, row),
    state: githubStateOfRow(ctx.db, row),
  };
}

// Web のダイアログが編集のたびに呼ぶ再検査。gh は呼ばない
export function checkGithubPublishText(db: Database, input: { title: string; body: string }, deps: GithubPublishDeps = {}): LeakFinding[] {
  validateText(input);
  return detectLeaks(input, leakConfigOf(db, deps));
}

function parseIncluded(stdout: string): { status: number; body: string } | null {
  const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n/.exec(stdout);
  if (!m) return null;
  const sep = /\r?\n\r?\n/.exec(stdout);
  return { status: Number(m[1]), body: sep ? stdout.slice(sep.index + sep[0].length) : "" };
}

const httpStatusOf = (stderr: string): number | null => {
  const m = /\(HTTP (\d{3})\)/.exec(stderr);
  return m ? Number(m[1]) : null;
};

export function classifyCreate(result: GhRunResult, repo: string): CreateOutcome {
  if (result.kind === "not_found") return { kind: "failed", code: "GH_NOT_INSTALLED", message: "gh が見つかりません。GitHub CLI を導入してください" };
  if (result.kind === "spawn_failed") return { kind: "failed", code: "GH_FAILED", message: `gh を起動できませんでした: ${result.detail}` };
  if (result.kind === "timeout") return { kind: "unknown", message: "gh が時間内に終わりませんでした" };
  if (result.kind === "too_large") return { kind: "unknown", message: "gh の出力が大きすぎます" };
  const response = parseIncluded(result.stdout);
  const status = response?.status ?? httpStatusOf(result.stderr);
  if (result.exitCode !== 0 || status !== 201) {
    if (status !== null && DEFINITE_REJECTIONS.includes(status)) {
      const detail = result.stderr.trim().split("\n")[0]?.slice(0, 200);
      return { kind: "failed", code: status === 401 ? "GH_AUTH" : "GH_FAILED", message: `GitHub が作成を拒否しました（HTTP ${status}${detail ? `: ${detail}` : ""}）` };
    }
    return { kind: "unknown", message: status !== null ? `HTTP ${status}` : `gh が失敗しました（終了コード ${result.exitCode}）` };
  }
  let data: { number?: unknown; html_url?: unknown };
  try {
    data = JSON.parse(response?.body ?? "");
  } catch {
    return { kind: "unknown", message: "応答を読めませんでした" };
  }
  const number = data.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || typeof data.html_url !== "string") {
    return { kind: "unknown", message: "応答に番号と URL がありません" };
  }
  let actual: { repo: string; number: number };
  try {
    actual = parseGithubIssueUrl(data.html_url);
  } catch {
    return { kind: "unknown", message: `応答の URL（${data.html_url}）を読めません` };
  }
  if (actual.number !== number) return { kind: "unknown", message: `応答の URL（${data.html_url}）が番号と一致しません` };
  // repo が移管・改名されていると、宛先と違う repo の URL が返る。作成は成功しているので、実際の repo で記録する
  return { kind: "sent", number, url: githubIssueUrl(actual.repo, number), repo: actual.repo };
}

function finishAttempt(ctx: OpCtx, attemptId: string, state: "failed" | "unknown", error: string): void {
  tx(ctx.db, () => {
    const res = ctx.db.query("UPDATE github_publishes SET state = ?, error = ?, finished_at = ? WHERE attempt_id = ? AND state = 'sending'").run(state, error, now(), attemptId);
    if (state === "unknown" && res.changes > 0) {
      const a = ctx.db.query("SELECT issue_id, repo FROM github_publishes WHERE attempt_id = ?").get(attemptId) as { issue_id: number; repo: string };
      recordEvent(ctx.db, a.issue_id, ctx.actor, "github_publish_unknown", { repo: a.repo, attempt: attemptId, reason: error });
    }
  });
}

function unknownError(id: string, repo: string, attemptId: string, reason: string): NodError {
  return new NodError(
    "GITHUB_RESULT_UNKNOWN",
    `GitHub Issue が作られたか分かりません（${reason}）。GitHub の ${repo} を確かめ、作られていれば nod issue link-github ${id} <URL>、作られていなければ nod issue publish ${id} --clear-unknown で解除してください`,
    { attemptId, repo },
  );
}

// 作成の成功を試行に記録する。解除などで試行の状態が変わっていても sent にする（作られたことは事実のため）。
// 対応の記録とは別の transaction にし、対応を記録できなくても sent は残す（再公開を防ぎ、紐付けで復旧できるようにする）
function markSent(ctx: OpCtx, attemptId: string, sent: { number: number; url: string }): void {
  tx(ctx.db, () => {
    ctx.db
      .query("UPDATE github_publishes SET state = 'sent', result_number = ?, result_url = ?, error = NULL, finished_at = ? WHERE attempt_id = ?")
      .run(sent.number, sent.url, now(), attemptId);
  });
}

function publishedEvent(ctx: OpCtx, issueRowId: number, attemptId: string, sent: { number: number; url: string; repo: string }, recorded: boolean): void {
  recordEvent(ctx.db, issueRowId, ctx.actor, "github_published", { url: sent.url, repo: sent.repo, number: sent.number, attempt: attemptId, recorded });
}

// 対応を記録する。別の対応があれば上書きしない
function recordLink(ctx: OpCtx, issueRowId: number, attemptId: string, requested: string, sent: { number: number; url: string; repo: string }): GithubPublishResult {
  return tx(ctx.db, () => {
    const row = issueRowById(ctx.db, issueRowId);
    const id = formatIssueId(row.ws_key, row.number);
    const key = sourceKeyOf(sent.repo, sent.number);
    const own = githubLinkOf(ctx.db, row.id);
    const taken = ctx.db
      .query("SELECT id, issue_id FROM issue_imports WHERE workspace_id = ? AND source = 'github' AND source_key = ?")
      .get(row.workspace_id, key) as { id: number; issue_id: number | null } | null;
    let recorded = false;
    if (own) recorded = sourceKeyOf(own.repo, own.number) === key;
    else if (!taken) {
      ctx.db
        .query("INSERT INTO issue_imports (workspace_id, source, source_key, issue_id, imported_by, imported_at, origin) VALUES (?, 'github', ?, ?, ?, ?, 'publish')")
        .run(row.workspace_id, key, row.id, ctx.actor, now());
      recorded = true;
    } else if (taken.issue_id === null) {
      ctx.db.query("UPDATE issue_imports SET issue_id = ?, origin = 'publish', imported_by = ?, imported_at = ? WHERE id = ?").run(row.id, ctx.actor, now(), taken.id);
      recorded = true;
    }
    const messages: string[] = [];
    if (sent.repo !== requested) messages.push(`宛先 ${requested} ではなく ${sent.repo} に作られました（repo の移管・改名の可能性があります）`);
    if (!recorded) messages.push(`GitHub Issue ${sent.url} は作成しましたが、対応を記録できませんでした（すでに別の対応があります）。nod issue link-github ${id} で整理してください`);
    publishedEvent(ctx, row.id, attemptId, sent, recorded);
    return { issueId: id, attemptId, repo: sent.repo, number: sent.number, url: sent.url, recorded, message: messages.length ? messages.join("。") : null };
  });
}

export async function publishGithubIssue(ctx: OpCtx, ref: string, input: GithubPublishInput, deps: GithubPublishDeps = {}): Promise<GithubPublishResult> {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は GitHub Issue を作成できません（nod issue publish --dry-run での確認はできます）。作成は me に依頼してください");
  }
  validateText(input);
  const repo = normalizeGithubRepo(input.repo);
  const findings = detectLeaks({ title: input.title, body: input.body }, leakConfigOf(ctx.db, deps));
  if (findings.length) throw leakError(findings);
  const gh = deps.gh ?? ghRunner;
  const attemptId = randomUUID();
  let row: IssueRow;
  try {
    row = tx(ctx.db, () => {
      const current = findIssueRow(ctx.db, ref);
      const blocker = blockersOf(ctx.db, current)[0];
      if (blocker) throw new NodError(blocker.code, blocker.message);
      const configured = githubRepoOfWorkspace(ctx.db, current.workspace_id);
      if (!configured) throw new NodError("GITHUB_REPO_NOT_SET", "公開先が未設定です。nod workspace github set <owner/repo> で設定してください");
      if (configured !== repo) throw new NodError("GITHUB_TARGET_CHANGED", `公開先が ${repo} から ${configured} に変わりました。確認し直してください`);
      ctx.db
        .query(
          `INSERT INTO github_publishes (attempt_id, issue_id, workspace_id, repo, title, body, gh_login, state, started_by, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?)`,
        )
        .run(attemptId, current.id, current.workspace_id, repo, input.title, input.body, input.ghLogin, ctx.actor, now());
      return current;
    });
  } catch (e) {
    // 別の接続が同時に送信権を取った（部分 UNIQUE に当たった）
    if (e instanceof Error && /UNIQUE constraint failed: github_publishes\.issue_id/.test(e.message)) {
      throw new NodError("GITHUB_PUBLISH_PENDING", "GitHub に送信中です。終わってから確かめてください");
    }
    throw e;
  }
  const id = formatIssueId(row.ws_key, row.number);
  const login = await fetchLogin(gh);
  if ("error" in login) {
    finishAttempt(ctx, attemptId, "failed", login.error.message);
    throw new NodError(login.error.code, login.error.message);
  }
  if (login.login !== input.ghLogin) {
    const message = `gh のアカウントが ${input.ghLogin} から ${login.login} に変わりました。確認し直してください`;
    finishAttempt(ctx, attemptId, "failed", message);
    throw new NodError("GITHUB_TARGET_CHANGED", message);
  }
  let dir: string;
  let file: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "nod-gh-publish-")); // 0700 で作られる
    file = join(dir, "issue.json");
    writeFileSync(file, JSON.stringify({ title: input.title, body: input.body }), { mode: 0o600 });
  } catch (e) {
    const message = `送信用の一時ファイルを作れませんでした: ${e instanceof Error ? e.message : String(e)}`;
    finishAttempt(ctx, attemptId, "failed", message);
    throw new NodError("GH_FAILED", message);
  }
  let outcome: CreateOutcome;
  try {
    const result = await gh(["api", "--hostname", "github.com", "-X", "POST", `repos/${repo}/issues`, "--include", "--input", file], {
      timeoutMs: GITHUB_CREATE_TIMEOUT_MS,
      maxStdoutBytes: 1024 * 1024,
    });
    outcome = classifyCreate(result, repo);
  } catch (e) {
    outcome = { kind: "unknown", message: `gh の実行中に想定外のエラー: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (outcome.kind === "failed") {
    finishAttempt(ctx, attemptId, "failed", outcome.message);
    throw new NodError(outcome.code, outcome.message);
  }
  if (outcome.kind === "unknown") {
    finishAttempt(ctx, attemptId, "unknown", outcome.message);
    throw unknownError(id, repo, attemptId, outcome.message);
  }
  try {
    markSent(ctx, attemptId, outcome);
    return recordLink(ctx, row.id, attemptId, repo, outcome);
  } catch (e) {
    // 作成は成功している。再送はせず、得られた URL での紐付けを案内する。
    // sent を記録できていれば再公開は止まる（記録できていなければ試行は sending のまま期限切れで結果不明になる）
    try {
      tx(ctx.db, () => publishedEvent(ctx, row.id, attemptId, outcome, false));
    } catch {
      // Activity を残せなくても、案内のエラーを優先する
    }
    throw new NodError(
      "GITHUB_RECORD_FAILED",
      `GitHub Issue ${outcome.url} は作成しましたが、nod への記録に失敗しました（${e instanceof Error ? e.message : String(e)}）。nod issue link-github ${id} ${outcome.url} で紐付けてください`,
      { url: outcome.url },
    );
  }
}

export function clearUnknownGithubPublish(ctx: OpCtx, ref: string): GithubIssueState {
  if (isLlm(ctx)) throw new NodError("FORBIDDEN_FOR_LLM", "LLM は結果不明の送信を解除できません。GitHub で確かめたうえで、解除は me に依頼してください");
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    const id = formatIssueId(row.ws_key, row.number);
    const pending = pendingAttemptOf(ctx.db, row.id);
    if (!pending || pending.state !== "unknown") throw new NodError("INVALID_STATE", `${id} に結果不明の送信はありません`);
    ctx.db
      .query("UPDATE github_publishes SET state = 'cleared', cleared_by = ?, cleared_at = ? WHERE attempt_id = ? AND state IN ('sending', 'unknown')")
      .run(ctx.actor, now(), pending.attemptId);
    recordEvent(ctx.db, row.id, ctx.actor, "github_publish_cleared", { repo: pending.repo, attempt: pending.attemptId });
    return githubStateOfRow(ctx.db, row);
  });
}
