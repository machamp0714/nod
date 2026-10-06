import type { Database } from "bun:sqlite";
import { isLlm, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { findIssueRow, formatIssueId } from "../issue-query";
import { transitionBlockReason } from "../transition-rules";
import type { GitSyncCandidate, GitSyncRefMissReason, GitSyncResult, Status, Workspace } from "../types";
import { applyAutoTransition } from "./auto-transitions";
import { AUTOMATION_DAYS_MAX, AUTOMATION_LIMIT_DEFAULT, AUTOMATION_LIMIT_MAX, getAutomationSettings } from "./automation";
import { githubRepoOfWorkspace, type OriginRepo, readOriginRepo } from "./github-repo";
import { sourceKeyOf } from "./github-links";
import { createCommandRunner, type GhRunner, type GhRunResult } from "./pr-status";
import { findWorkspace } from "./workspaces";

// コミット連動（#68）。Workspace のリポジトリの git log を読み、コミットメッセージの Closes/Fixes/Resolves <ID> で
// Issue を in_review に進める（done にはしない）。git へは読み取りだけで、fetch もしない
export const GIT_SYNC_SINCE_DAYS_DEFAULT = 30;
export const GIT_SYNC_SCAN_MAX = 1000; // 1回に読むコミットの上限
export const GIT_SYNC_TIMEOUT_MS = 15_000;
// コミットで作業が済んだことを表すので、着手前（backlog・todo）も進める。Triage・確認待ち・レビュー待ち以降は対象外。
// 未回答の確認依頼（書き手を問わない）が残る backlog・todo も対象外（人が確認待ちから手で出しても、決まるまで着手の状態にしない。#170）
export const COMMIT_REVIEW_FROM: Status[] = ["backlog", "todo", "in_progress"];

export type GitRunner = GhRunner;
// 呼び出し元の GIT_DIR・GIT_WORK_TREE などに引きずられず、-C のパスのリポジトリを読むよう GIT_ で始まる環境変数を除く
export function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith("GIT_")));
}
export const gitRunner: GitRunner = createCommandRunner("git", [], { env: gitEnv });

const KEYWORD = String.raw`(close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;
const ID = String.raw`[A-Za-z0-9]{2,6}-\d+(?![\w-])`;
// キーワード（単語の頭から）・任意のコロン・ID の並び（, / and / & 区切り）
const CLOSING_RE = new RegExp(String.raw`(?<![\w-])${KEYWORD}:?\s+(${ID}(?:\s*(?:,|&|\band\b)\s*${ID})*)`, "gi");
const ID_RE = new RegExp(ID, "gi");

// ``` で囲まれた行（閉じていなければ末尾まで）を除く。コード例に書いた ID で遷移させない
function stripCodeBlocks(message: string): string {
  let inBlock = false;
  const kept: string[] = [];
  for (const line of message.split("\n")) {
    if (/^\s*```/.test(line)) {
      inBlock = !inBlock;
      continue;
    }
    if (!inBlock) kept.push(line);
  }
  return kept.join("\n");
}

// Revert コミットは作業の完了を表さないので読まない（git revert の既定の件名・本文）
export function isRevertCommit(subject: string, body: string): boolean {
  return subject.startsWith('Revert "') || body.includes("This reverts commit");
}

// メッセージから、その Workspace のキーの Issue ID を拾う（同じ ID は最初の1回だけ）
export function findClosingRefs(message: string, workspaceKey: string): { id: string; keyword: string }[] {
  const found: { id: string; keyword: string }[] = [];
  for (const m of stripCodeBlocks(message).matchAll(CLOSING_RE)) {
    for (const idMatch of (m[2] ?? "").matchAll(ID_RE)) {
      const [key, number] = idMatch[0].split("-");
      if (key?.toUpperCase() !== workspaceKey.toUpperCase()) continue;
      const id = formatIssueId(workspaceKey.toUpperCase(), Number(number));
      if (!found.some((f) => f.id === id)) found.push({ id, keyword: m[1] ?? "" });
    }
  }
  return found;
}

// GitHub の番号の参照。#12、owner/repo#12、https://github.com/owner/repo/issues/12（PR の URL は対象外）
const GH_REF = String.raw`(?:https://github\.com/[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+/issues/\d+|[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+#\d+|#\d+)(?![\w-])`;
const GH_CLOSING_RE = new RegExp(String.raw`(?<![\w-])${KEYWORD}:?\s+(${GH_REF}(?:\s*(?:,|&|\band\b)\s*${GH_REF})*)`, "gi");
const GH_REF_RE = new RegExp(GH_REF, "gi");

export interface GithubClosingRef {
  raw: string;
  repo: string | null; // #12 のように repo を書かないときは null（origin の repo で補う）。書いたときは小文字
  number: number;
  keyword: string;
}

export function findGithubClosingRefs(message: string): GithubClosingRef[] {
  const found: GithubClosingRef[] = [];
  for (const m of stripCodeBlocks(message).matchAll(GH_CLOSING_RE)) {
    for (const r of (m[2] ?? "").matchAll(GH_REF_RE)) {
      const raw = r[0];
      const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/i.exec(raw);
      const qualified = /^([^/#]+)\/([^#]+)#(\d+)$/.exec(raw);
      const parsed = url
        ? { repo: `${url[1]}/${url[2]}`.toLowerCase(), number: Number(url[3]) }
        : qualified
          ? { repo: `${qualified[1]}/${qualified[2]}`.toLowerCase(), number: Number(qualified[3]) }
          : { repo: null, number: Number(raw.slice(1)) };
      if (!found.some((f) => f.raw.toLowerCase() === raw.toLowerCase())) found.push({ raw, ...parsed, keyword: m[1] ?? "" });
    }
  }
  return found;
}

// origin の repo・今の公開先・参照の repo の3つが一致するときだけ、対応表（経路は問わない）から nod の Issue に解決する。
// origin・公開先・参照の repo はどれも小文字に揃えてあるが、念のため大文字小文字を区別せず比べる（GitHub の repo 名は区別しない）
function resolveGithubRef(db: Database, workspace: Workspace, ref: GithubClosingRef, origin: OriginRepo, configured: string | null): { id: string } | { reason: GitSyncRefMissReason } {
  if (origin.repo === null) return { reason: origin.reason };
  if (!configured) return { reason: "repo_not_set" };
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(origin.repo, configured)) return { reason: "repo_mismatch" };
  const repo = ref.repo ?? origin.repo;
  if (!same(repo, configured)) return { reason: "repo_mismatch" };
  const row = db
    .query(
      `SELECT i.number FROM issue_imports m JOIN issues i ON i.id = m.issue_id
       WHERE m.workspace_id = ? AND m.source = 'github' AND m.source_key = ? AND i.workspace_id = ?`,
    )
    .get(workspace.id, sourceKeyOf(repo, ref.number), workspace.id) as { number: number } | null;
  return row ? { id: formatIssueId(workspace.key, row.number) } : { reason: "not_linked" };
}

interface Commit {
  sha: string;
  committedAt: string; // ISO（UTC）
  subject: string;
  body: string;
}

const FIELD = "\x1f";
const RECORD = "\x1e";

async function readCommits(run: GitRunner, path: string, ref: string, sinceDays: number): Promise<Commit[]> {
  const result: GhRunResult = await run(
    ["-c", "log.showSignature=false", "-C", path, "log", ref, `--since=${sinceDays}.days.ago`, `--max-count=${GIT_SYNC_SCAN_MAX}`, "--no-color", `--format=%H${FIELD}%cI${FIELD}%s${FIELD}%B${RECORD}`, "--"],
    { timeoutMs: GIT_SYNC_TIMEOUT_MS },
  );
  if (result.kind === "not_found") throw new NodError("GIT_FAILED", "git が見つかりません");
  if (result.kind === "timeout") throw new NodError("GIT_FAILED", `git log が ${GIT_SYNC_TIMEOUT_MS / 1000}秒以内に終わりませんでした`);
  if (result.kind === "spawn_failed") throw new NodError("GIT_FAILED", `git を起動できませんでした: ${result.detail}`);
  // 上限を渡していないので起きないが、型の上では残る
  if (result.kind === "too_large") throw new NodError("GIT_FAILED", "git log の出力が大きすぎます");
  if (result.exitCode !== 0) {
    // コミットがまだないリポジトリの HEAD は 0 件として扱う（git の版で文言が違うので、コミットの有無を直接確かめる）
    if (ref === "HEAD") {
      const any = await run(["-C", path, "rev-list", "-n", "1", "--all"], { timeoutMs: GIT_SYNC_TIMEOUT_MS });
      if (any.kind === "exited" && any.exitCode === 0 && any.stdout.trim() === "") return [];
    }
    const detail = result.stderr.trim().split("\n")[0]?.slice(0, 200) || `終了コード ${result.exitCode}`;
    throw new NodError("GIT_FAILED", `git log を読めませんでした（${path}）: ${detail}`);
  }
  return result.stdout
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim() !== "")
    .map((r) => {
      const [sha = "", date = "", subject = "", body = ""] = r.split(FIELD);
      return { sha, committedAt: new Date(date).toISOString(), subject, body };
    });
}

interface CandidateRow {
  id: number;
  number: number;
  title: string;
  status: Status;
}

// 実行時の再確認にも使う。対象の状態で、backlog・todo なら未回答の確認依頼がなく、同じコミットの記録がなく、コミットのあとに in_review になっていない。
// 一度でも in_review から動いた（人の差し戻し・取消）Issue は、新しいコミット（rebase・cherry-pick で SHA が変わったものを含む）でも進めない
function eligible(db: Database, workspace: Workspace, number: number, sha: string, committedAt: string): CandidateRow | null {
  return db
    .query(
      `SELECT i.id, i.number, i.title, i.status FROM issues i
       WHERE i.workspace_id = ? AND i.number = ? AND i.archived_at IS NULL
         AND i.status IN (${COMMIT_REVIEW_FROM.map(() => "?").join(", ")})
         AND NOT (i.status IN ('backlog', 'todo') AND EXISTS (SELECT 1 FROM questions q WHERE q.issue_id = i.id AND q.answer IS NULL))
         AND NOT EXISTS (SELECT 1 FROM auto_transitions t WHERE t.issue_id = i.id AND t.source = 'commit' AND t.source_key = ?)
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.issue_id = i.id AND e.type = 'status_changed'
           AND json_extract(e.data, '$.to') = 'in_review' AND e.created_at >= ?)
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.issue_id = i.id AND e.type = 'status_changed'
           AND json_extract(e.data, '$.from') = 'in_review')`,
    )
    .get(workspace.id, number, ...COMMIT_REVIEW_FROM, sha, committedAt) as CandidateRow | null;
}

function validate(opts: { sinceDays: number; limit: number; ref: string }): void {
  if (!Number.isSafeInteger(opts.sinceDays) || opts.sinceDays < 1 || opts.sinceDays > AUTOMATION_DAYS_MAX) {
    throw new NodError("INVALID_ARGS", `--since は 1〜${AUTOMATION_DAYS_MAX} の整数（日数）で指定してください`);
  }
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > AUTOMATION_LIMIT_MAX) {
    throw new NodError("INVALID_ARGS", `--limit は 1〜${AUTOMATION_LIMIT_MAX} の整数で指定してください`);
  }
  // git のオプションとして解釈される値や空白を含む値は受け付けない
  if (opts.ref === "" || opts.ref.startsWith("-") || /\s/.test(opts.ref)) {
    throw new NodError("INVALID_ARGS", `--ref には ブランチ名・タグ・コミット を指定してください（${opts.ref || "空"}）`);
  }
}

// 読んだコミットから候補を作る。同じ Issue は最新のコミット（git log の先頭側）だけを使い、古いコミット順に並べる
export async function syncGitCommits(
  ctx: OpCtx,
  keyOrPath: string,
  opts: { dryRun?: boolean; sinceDays?: number; ref?: string; limit?: number } = {},
  run: GitRunner = gitRunner,
): Promise<GitSyncResult> {
  const dryRun = opts.dryRun ?? false;
  const sinceDays = opts.sinceDays ?? GIT_SYNC_SINCE_DAYS_DEFAULT;
  const ref = opts.ref ?? "HEAD";
  const limit = opts.limit ?? AUTOMATION_LIMIT_DEFAULT;
  validate({ sinceDays, limit, ref });
  const workspace = findWorkspace(ctx.db, keyOrPath);
  if (!workspace) throw new NodError("NOT_FOUND", `Workspace ${keyOrPath} は登録されていません`);
  const enabled = getAutomationSettings(ctx.db, workspace.key).commitReview;
  if (!dryRun) {
    if (isLlm(ctx)) {
      throw new NodError("FORBIDDEN_FOR_LLM", "LLM は nod git sync を実行できません（--dry-run での確認はできます）。実行は me に依頼してください");
    }
    if (!enabled) {
      throw new NodError("AUTOMATION_DISABLED", "コミット連動が無効です。nod automation set --commit-review on で有効にしてください");
    }
  }
  const commits = await readCommits(run, workspace.path, ref, sinceDays);
  const byIssue = new Map<string, GitSyncCandidate & { at: number }>();
  const configured = githubRepoOfWorkspace(ctx.db, workspace.id);
  let origin: OriginRepo | null = null; // GitHub の参照があったときだけ読む
  const unresolvedRefs: GitSyncResult["unresolvedRefs"] = [];
  for (const c of commits) {
    if (isRevertCommit(c.subject, c.body)) continue;
    const message = c.body || c.subject;
    const refs: { id: string; keyword: string; ref?: string }[] = findClosingRefs(message, workspace.key);
    const ghRefs = findGithubClosingRefs(message);
    if (ghRefs.length) {
      origin ??= await readOriginRepo(run, workspace.path);
      for (const g of ghRefs) {
        const resolved = resolveGithubRef(ctx.db, workspace, g, origin, configured);
        if ("reason" in resolved) {
          unresolvedRefs.push({ sha: c.sha, ref: g.raw, reason: resolved.reason });
          continue;
        }
        if (!refs.some((r) => r.id === resolved.id)) refs.push({ id: resolved.id, keyword: g.keyword, ref: g.raw });
      }
    }
    for (const r of refs) {
      if (byIssue.has(r.id)) continue; // 新しいコミットが先に来る
      const row = eligible(ctx.db, workspace, Number(r.id.split("-")[1]), c.sha, c.committedAt);
      if (!row) continue;
      byIssue.set(r.id, {
        id: r.id,
        title: row.title,
        status: row.status,
        sha: c.sha,
        subject: c.subject,
        keyword: r.keyword,
        ...(r.ref ? { ref: r.ref } : {}),
        committedAt: c.committedAt,
        at: Date.parse(c.committedAt),
      });
    }
  }
  const found = [...byIssue.values()].sort((a, b) => a.at - b.at || Number(a.id.split("-")[1]) - Number(b.id.split("-")[1]));
  const candidates = found.slice(0, limit).map(({ at: _at, ...c }) => {
    const reason = transitionBlockReason(ctx.db, workspace, c.status, "in_review");
    return reason ? { ...c, ruleSkipReason: reason } : c;
  });
  const result: GitSyncResult = {
    workspaceKey: workspace.key,
    ref,
    sinceDays,
    dryRun,
    enabled,
    scanned: commits.length,
    truncated: commits.length >= GIT_SYNC_SCAN_MAX,
    total: found.length,
    candidates,
    processed: [],
    skipped: [],
    skippedReasons: [],
    failed: [],
    remaining: found.length - candidates.length,
    unresolvedRefs,
  };
  if (dryRun) return result;
  // 1件ごとに確定し、途中で失敗しても残りを続ける。読んでから書くまでに変わりうるので、書く transaction の中で確かめ直す
  for (const c of candidates) {
    try {
      const done = tx(ctx.db, () => {
        const row = findIssueRow(ctx.db, c.id);
        if (!eligible(ctx.db, workspace, row.number, c.sha, c.committedAt)) return false;
        const skip = transitionBlockReason(ctx.db, workspace, row.status, "in_review");
        if (skip) return skip;
        applyAutoTransition(ctx, row, {
          source: "commit",
          sourceKey: c.sha,
          reason: `コミット ${c.sha.slice(0, 12)}「${c.subject.slice(0, 80)}」の ${c.keyword} ${c.ref ?? c.id}`,
          automation: "commit_review",
        });
        return true;
      });
      (done === true ? result.processed : result.skipped).push(c.id);
      if (typeof done === "string") result.skippedReasons.push({ id: c.id, message: done });
    } catch (e) {
      result.failed.push({ id: c.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
