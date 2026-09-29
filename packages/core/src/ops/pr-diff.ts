import type { Database } from "bun:sqlite";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { findIssueRow, formatIssueId } from "../issue-query";
import type { PrDiff, PrDiffErrorCode, PrDiffFile, PrDiffFileStatus, PrDiffView } from "../types";
import { classify, GITHUB_PR_URL_RE, type GhRunner, type GhRunResult, ghRunner, known, PR_STATUS_TIMEOUT_MS, unknown } from "./pr-status";

// 取得範囲（#55）。ファイル数は GitHub の diff の上限と同じ。超えたら差分は保存せず GitHub で見てもらう
export const PR_DIFF_MAX_FILES = 300;
export const PR_DIFF_MAX_BYTES = 5 * 1024 * 1024;
// これを超えるファイルは本文を保存しない（パス・行数は残す）
export const PR_DIFF_FILE_MAX_BYTES = 200 * 1024;
export const PR_DIFF_FILE_MAX_LINES = 5_000;

const VIEW_FIELDS = "headRefOid,baseRefOid,changedFiles";
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+\/?$/;
const TOO_LARGE_RE = /HTTP 406|exceeded the maximum|too[ _]large/i;

type DiffData = Omit<PrDiff, "prUrl" | "fetchedAt" | "fetchedBy">;
type Failure = { code: PrDiffErrorCode; message: string };

function tooLarge(detail: string): Failure {
  return { code: "DIFF_TOO_LARGE", message: `差分が大きすぎます（${detail}）。GitHub で確認してください` };
}

// git が引用符で囲んだパス（"a/\346\227\245.md" など）を元に戻す。8進表記はバイト列として UTF-8 で読む
function unquote(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const bytes: number[] = [];
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, "\\": 92, '"': 34 };
  const body = raw.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const next = body[i + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else if (next in escapes) {
      bytes.push(escapes[next]!);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// --- / +++ の行のパス。/dev/null は null。git が空白を含むパスの後ろに付けるタブを除く
function headerPath(rest: string, prefix: "a/" | "b/"): string | null {
  const raw = rest.endsWith("\t") ? rest.slice(0, -1) : rest;
  if (raw === "/dev/null") return null;
  const path = unquote(raw);
  return path.startsWith(prefix) ? path.slice(2) : path;
}

// diff --git a/X b/Y から X と Y を取る。--- / +++ のない変更（モードだけ・バイナリ・完全な名前変更）で使う
function gitHeaderPaths(rest: string): [string, string] | null {
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*")$|^("(?:[^"\\]|\\.)*") (\S+)$/.exec(rest);
  if (quoted && (rest.startsWith('"') || rest.endsWith('"'))) {
    const a = unquote(quoted[1] ?? quoted[3]!);
    const b = unquote(quoted[2] ?? quoted[4]!);
    return [a.replace(/^a\//, ""), b.replace(/^b\//, "")];
  }
  // 引用符なしで同じパスなら "a/P b/P" の真ん中で分ける（P に " b/" を含んでも分けられる）
  const half = (rest.length - 5) / 2;
  if (Number.isInteger(half) && rest.startsWith("a/") && rest.slice(2, 2 + half) === rest.slice(5 + half)) {
    return [rest.slice(2, 2 + half), rest.slice(5 + half)];
  }
  const at = rest.indexOf(" b/");
  return at > 0 && rest.startsWith("a/") ? [rest.slice(2, at), rest.slice(at + 3)] : null;
}

function parseBlock(lines: string[]): PrDiffFile {
  const headerPaths = gitHeaderPaths(lines[0]!.slice("diff --git ".length));
  let status: PrDiffFileStatus = "modified";
  let binary = false;
  let oldPath: string | null | undefined;
  let newPath: string | null | undefined;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let i = 1;
  for (; i < lines.length && !lines[i]!.startsWith("@@"); i++) {
    const line = lines[i]!;
    if (line.startsWith("new file mode")) status = "added";
    else if (line.startsWith("deleted file mode")) status = "deleted";
    else if (line.startsWith("rename from ")) renameFrom = unquote(line.slice(12));
    else if (line.startsWith("rename to ")) renameTo = unquote(line.slice(10));
    else if (line.startsWith("copy to ")) renameTo = unquote(line.slice(8));
    else if (line.startsWith("--- ")) oldPath = headerPath(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) newPath = headerPath(line.slice(4), "b/");
    else if (line === "GIT binary patch" || (line.startsWith("Binary files ") && line.endsWith(" differ"))) binary = true;
  }
  const hunk = lines.slice(i);
  while (hunk.length > 0 && hunk[hunk.length - 1] === "") hunk.pop();
  let additions = 0;
  let deletions = 0;
  for (const line of hunk) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  const before = renameFrom ?? oldPath ?? headerPaths?.[0] ?? null;
  const after = renameTo ?? newPath ?? headerPaths?.[1] ?? before;
  let path = after ?? before ?? "";
  let from: string | null = null;
  if (status === "deleted") path = before ?? path;
  else if (renameFrom !== null && renameTo !== null && renameFrom !== renameTo) {
    status = "renamed";
    from = renameFrom;
  }
  const patch = hunk.join("\n");
  let omitted: PrDiffFile["omitted"] = null;
  if (binary) omitted = "binary";
  else if (hunk.length > PR_DIFF_FILE_MAX_LINES || Buffer.byteLength(patch) > PR_DIFF_FILE_MAX_BYTES) omitted = "too_large";
  return { path, oldPath: from, status, binary, additions, deletions, patch: omitted ? null : patch, omitted };
}

// unified diff（git の形式）をファイルごとに分ける。+/- はハンク（最初の @@ 以降）の中だけを数える
export function parseUnifiedDiff(text: string): PrDiffFile[] {
  const files: PrDiffFile[] = [];
  let block: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (block) files.push(parseBlock(block));
      block = [line];
    } else if (block) {
      block.push(line);
    }
  }
  if (block) files.push(parseBlock(block));
  return files;
}

function failureOf(result: GhRunResult): Failure {
  if (result.kind === "exited" && TOO_LARGE_RE.test(result.stderr)) return tooLarge(`上限: ファイル ${PR_DIFF_MAX_FILES} 件・${PR_DIFF_MAX_BYTES / 1024 / 1024} MB`);
  return classify(result as Exclude<GhRunResult, { kind: "exited"; exitCode: 0 }>);
}

const succeeded = (r: GhRunResult): r is Extract<GhRunResult, { kind: "exited" }> => r.kind === "exited" && r.exitCode === 0;

// gh pr view で HEAD と base の SHA を取り、その2つに固定した compare の差分を取る。
// 取得中に push されても、保存する SHA と差分は食い違わない。GitHub へは読み取り（GET）だけ
async function fetchDiff(prUrl: string, run: GhRunner): Promise<{ data: DiffData } | { error: Failure }> {
  const repo = REPO_RE.exec(prUrl);
  if (!GITHUB_PR_URL_RE.test(prUrl) || !repo || [repo[1], repo[2]].some((p) => p === "." || p === "..")) {
    return { error: known("INVALID_URL") };
  }
  const view = await run(["pr", "view", prUrl, "--json", VIEW_FIELDS], { timeoutMs: PR_STATUS_TIMEOUT_MS });
  if (!succeeded(view)) return { error: failureOf(view) };
  let head: unknown;
  let base: unknown;
  let changedFiles: unknown;
  try {
    ({ headRefOid: head, baseRefOid: base, changedFiles } = JSON.parse(view.stdout) as Record<string, unknown>);
  } catch {
    return { error: unknown("gh の出力を解釈できませんでした") };
  }
  // SHA は gh の api のパスに入れるので、形を確かめてから使う
  if (typeof head !== "string" || typeof base !== "string" || !SHA_RE.test(head) || !SHA_RE.test(base)) {
    return { error: unknown("gh の出力を解釈できませんでした") };
  }
  if (typeof changedFiles === "number" && changedFiles > PR_DIFF_MAX_FILES) {
    return { error: tooLarge(`変更ファイル ${changedFiles} 件、上限 ${PR_DIFF_MAX_FILES} 件`) };
  }
  const diff = await run(["api", "-H", "Accept: application/vnd.github.diff", `repos/${repo[1]}/${repo[2]}/compare/${base}...${head}`], {
    timeoutMs: PR_STATUS_TIMEOUT_MS,
  });
  if (!succeeded(diff)) return { error: failureOf(diff) };
  if (Buffer.byteLength(diff.stdout) > PR_DIFF_MAX_BYTES) {
    return { error: tooLarge(`上限 ${PR_DIFF_MAX_BYTES / 1024 / 1024} MB`) };
  }
  const files = parseUnifiedDiff(diff.stdout);
  if (files.length > PR_DIFF_MAX_FILES) return { error: tooLarge(`変更ファイル ${files.length} 件、上限 ${PR_DIFF_MAX_FILES} 件`) };
  return {
    data: {
      headSha: head,
      baseSha: base,
      files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    },
  };
}

interface PrDiffRow {
  pr_url: string | null;
  head_sha: string | null;
  data: string | null;
  fetched_at: string | null;
  fetched_by: string | null;
  error_url: string | null;
  error_code: PrDiffErrorCode | null;
  error_message: string | null;
  error_at: string | null;
}

// 差分より後に取った PR 状態が別の HEAD を持つなら、その HEAD（差分は古い）
function newerHead(db: Database, issueRowId: number, prUrl: string, diffHead: string, diffFetchedAt: string): string | null {
  const s = db.query("SELECT pr_url, data, fetched_at FROM pr_statuses WHERE issue_id = ?").get(issueRowId) as {
    pr_url: string | null;
    data: string | null;
    fetched_at: string | null;
  } | null;
  if (!s?.data || s.pr_url !== prUrl || !s.fetched_at || s.fetched_at <= diffFetchedAt) return null;
  const head = (JSON.parse(s.data) as { headSha?: unknown }).headSha;
  return typeof head === "string" && head !== diffHead ? head : null;
}

function readView(db: Database, issueRowId: number, issueId: string, prUrl: string | null): PrDiffView {
  const view: PrDiffView = { issueId, prUrl, diff: null, stale: null, fetchError: null };
  const row = db.query("SELECT * FROM pr_diffs WHERE issue_id = ?").get(issueRowId) as PrDiffRow | null;
  if (!row || prUrl === null) return view;
  if (row.data && row.pr_url === prUrl && row.head_sha) {
    const fetchedAt = row.fetched_at ?? "";
    const current = newerHead(db, issueRowId, prUrl, row.head_sha, fetchedAt);
    if (current) view.stale = { diffHeadSha: row.head_sha, currentHeadSha: current };
    else view.diff = { prUrl, ...(JSON.parse(row.data) as DiffData), fetchedAt, fetchedBy: row.fetched_by ?? "" };
  }
  if (row.error_code && row.error_url === prUrl) {
    view.fetchError = { code: row.error_code, message: row.error_message ?? "", at: row.error_at ?? "" };
  }
  return view;
}

export function getPrDiff(db: Database, ref: string): PrDiffView {
  const row = findIssueRow(db, ref);
  return readView(db, row.id, formatIssueId(row.ws_key, row.number), row.pr_url);
}

// 同じ DB 接続・同じ Issue・同じ PR URL の取得中の更新は1本にまとめる（#67 と同じ）
const inflight = new WeakMap<Database, Map<string, Promise<PrDiffView>>>();

// PR の差分を gh で取得して保存する。人・LLM の明示の更新でだけ呼ぶ。
// 失敗は例外にせず fetchError として保存・返却し、前回の差分は残す。アクティビティ・通知には残さない
export function refreshPrDiff(ctx: OpCtx, ref: string, run: GhRunner = ghRunner): Promise<PrDiffView> {
  const row = findIssueRow(ctx.db, ref);
  const issueId = formatIssueId(row.ws_key, row.number);
  const prUrl = row.pr_url;
  if (!prUrl) return Promise.reject(new NodError("INVALID_ARGS", `Issue ${issueId} に PR がありません`));
  let byIssue = inflight.get(ctx.db);
  if (!byIssue) inflight.set(ctx.db, (byIssue = new Map()));
  const key = `${row.id} ${prUrl}`;
  const pending = byIssue.get(key);
  if (pending) return pending;
  const job = (async () => {
    try {
      const startedAt = now();
      save(ctx, row.id, prUrl, startedAt, await fetchDiff(prUrl, run));
      return getPrDiff(ctx.db, issueId);
    } finally {
      byIssue.delete(key);
    }
  })();
  byIssue.set(key, job);
  return job;
}

function save(ctx: OpCtx, issueRowId: number, prUrl: string, startedAt: string, outcome: { data: DiffData } | { error: Failure }): void {
  const at = now();
  tx(ctx.db, () => {
    // 取得中に PR URL が変わっていたら書かない。保存済みより後に始めた取得のときだけ書く（#67 と同じ）
    const current = ctx.db.query("SELECT pr_url FROM issues WHERE id = ?").get(issueRowId) as { pr_url: string | null } | null;
    if (current?.pr_url !== prUrl) return;
    if ("data" in outcome) {
      ctx.db
        .query(
          `INSERT INTO pr_diffs (issue_id, pr_url, head_sha, base_sha, data, fetched_at, fetched_by, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (issue_id) DO UPDATE SET pr_url = excluded.pr_url, head_sha = excluded.head_sha, base_sha = excluded.base_sha,
             data = excluded.data, fetched_at = excluded.fetched_at, fetched_by = excluded.fetched_by, started_at = excluded.started_at,
             error_url = NULL, error_code = NULL, error_message = NULL, error_at = NULL
           WHERE excluded.started_at >= pr_diffs.started_at`,
        )
        .run(issueRowId, prUrl, outcome.data.headSha, outcome.data.baseSha, JSON.stringify(outcome.data), at, ctx.actor, startedAt);
    } else {
      ctx.db
        .query(
          `INSERT INTO pr_diffs (issue_id, error_url, error_code, error_message, error_at, started_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (issue_id) DO UPDATE SET error_url = excluded.error_url, error_code = excluded.error_code,
             error_message = excluded.error_message, error_at = excluded.error_at, started_at = excluded.started_at
           WHERE excluded.started_at >= pr_diffs.started_at`,
        )
        .run(issueRowId, prUrl, outcome.error.code, outcome.error.message, at, startedAt);
    }
  });
}
