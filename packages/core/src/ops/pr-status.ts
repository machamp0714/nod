import type { Database } from "bun:sqlite";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { recordEvent } from "../events";
import { findIssueRow, findWritableIssueRow, formatIssueId, issueRowById, toIssue } from "../issue-query";
import { setColumn } from "../mutate";
import { applyPrReview } from "./auto-transitions";
import type {
  AutoTransition,
  Issue,
  PrCheck,
  PrCheckState,
  PrReviewDecision,
  PrState,
  PrStatus,
  PrStatusError,
  PrStatusErrorCode,
  PrStatusView,
} from "../types";

// gh の実行結果。テストはこの形を返すスタブを渡し、実際の gh・GitHub には触れない
export type GhRunResult =
  | { kind: "exited"; exitCode: number; stdout: string; stderr: string }
  | { kind: "not_found" } // コマンドが見つからない
  | { kind: "spawn_failed"; detail: string } // 見つかったが起動できない（EACCES など）
  | { kind: "timeout" } // 時間切れで止めた
  | { kind: "too_large"; limitBytes: number }; // 標準出力が maxStdoutBytes を超えたので読むのをやめて止めた
// maxStdoutBytes を渡すと、標準出力をそのバイト数までしか読まない
export type GhRunner = (args: string[], opts: { timeoutMs: number; maxStdoutBytes?: number }) => Promise<GhRunResult>;

export const PR_STATUS_TIMEOUT_MS = 15_000;
// 時間切れで SIGTERM を送ってから SIGKILL するまでの猶予
export const GH_KILL_GRACE_MS = 2_000;
// gh pr view の出力の上限。#55 の差分全体の上限（PR_DIFF_MAX_BYTES）と同じ 5MB
export const GH_OUTPUT_MAX_BYTES = 5 * 1024 * 1024;
// 標準エラーは分類に先頭だけ使うので、これを超えた分は読み捨てる
const STDERR_KEEP_BYTES = 64 * 1024;
// headRefOid は #55 の差分が古いか（HEAD が変わったか）を判定するために取る
const GH_FIELDS = "number,title,url,state,isDraft,reviewDecision,statusCheckRollup,mergedAt,headRefOid";
export const GITHUB_PR_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/;
const REVIEW_DECISIONS: readonly string[] = ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"] satisfies PrReviewDecision[];

const ERROR_MESSAGES: Record<Exclude<PrStatusErrorCode, "UNKNOWN">, string> = {
  INVALID_URL: "GitHub の PR URL ではありません",
  GH_NOT_INSTALLED: "gh が見つかりません。GitHub CLI を導入してください",
  GH_AUTH: "gh が未認証です。gh auth login を実行してください",
  PR_NOT_FOUND: "PR が見つかりません（削除またはアクセス権なし）",
  NETWORK: "GitHub に接続できません",
  TIMEOUT: `${PR_STATUS_TIMEOUT_MS / 1000}秒以内に応答がありませんでした`,
};

class OutputTooLarge extends Error {}

// ストリームをバイト列のまま読み、最後にまとめて UTF-8 にする（途中で区切ると多バイト文字が割れるため）。
// limit を超えたら OutputTooLarge で読むのをやめる。keep を渡すとそのバイト数だけ残し、残りは読み捨てる
async function readBytes(stream: ReadableStream<Uint8Array>, opts: { limit?: number; keep?: number }): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let kept = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (opts.limit !== undefined && total > opts.limit) throw new OutputTooLarge();
      if (opts.keep !== undefined && kept >= opts.keep) continue;
      const part = opts.keep !== undefined ? value.subarray(0, opts.keep - kept) : value;
      chunks.push(part);
      kept += part.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

// コマンドを起動して結果を返す。prefix は gh の前に置く引数（テストで bun スクリプトを gh の代わりにするため）。
// 時間切れか標準出力の上限超えになったら、出力や終了を待たずに timeout / too_large を返し、SIGTERM → 猶予 → SIGKILL で止める
// env を渡すと、その関数で process.env から起動時の環境を作る（git 用に GIT_DIR などを除くため）
export function createCommandRunner(
  command: string,
  prefix: string[] = [],
  opts: { killGraceMs?: number; env?: (base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv } = {},
): GhRunner {
  const killGraceMs = opts.killGraceMs ?? GH_KILL_GRACE_MS;
  return async (args, { timeoutMs, maxStdoutBytes }) => {
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn([command, ...prefix, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // 対話の確認を出させない。認証は gh 自身に任せ、nod はトークンを読まない
        env: { ...(opts.env ? opts.env(process.env) : process.env), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === "ENOENT") return { kind: "not_found" };
      return { kind: "spawn_failed", detail: err.code ?? err.message ?? String(e) };
    }
    const collected: Promise<GhRunResult> = Promise.all([
      readBytes(proc.stdout, { limit: maxStdoutBytes }),
      readBytes(proc.stderr, { keep: STDERR_KEEP_BYTES }),
      proc.exited,
    ]).then(
      ([stdout, stderr, exitCode]): GhRunResult => ({ kind: "exited", exitCode, stdout, stderr }),
      (e): GhRunResult => {
        if (e instanceof OutputTooLarge) return { kind: "too_large", limitBytes: maxStdoutBytes ?? 0 };
        throw e;
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<GhRunResult>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    });
    try {
      const result = await Promise.race([collected, timedOut]);
      if (result.kind === "timeout" || result.kind === "too_large") {
        collected.catch(() => {}); // 止めたあとの読み取りの失敗は捨てる
        proc.kill("SIGTERM");
        const killer = setTimeout(() => proc.kill("SIGKILL"), killGraceMs);
        void proc.exited.then(() => clearTimeout(killer));
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
}

export const ghRunner: GhRunner = createCommandRunner("gh");

interface RollupEntry {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string | null;
  targetUrl?: string | null;
}

// CheckRun は status（完了か）と conclusion、StatusContext は state で結果を持つ
function checkState(e: RollupEntry): PrCheckState {
  if (e.__typename === "StatusContext") {
    if (e.state === "SUCCESS") return "success";
    if (e.state === "PENDING" || e.state === "EXPECTED") return "pending";
    return "failure";
  }
  if (e.status !== "COMPLETED") return "pending";
  if (e.conclusion === "SUCCESS") return "success";
  if (e.conclusion === "NEUTRAL" || e.conclusion === "SKIPPED" || e.conclusion === "STALE") return "skipped";
  return "failure";
}

export function parseGhPrView(stdout: string): Omit<PrStatus, "prUrl" | "fetchedAt" | "fetchedBy"> {
  const raw = JSON.parse(stdout) as {
    number: number;
    title: string;
    state: PrState;
    isDraft: boolean;
    reviewDecision: string | null;
    mergedAt: string | null;
    statusCheckRollup: RollupEntry[] | null;
    headRefOid?: string;
  };
  if (typeof raw?.number !== "number" || !["OPEN", "CLOSED", "MERGED"].includes(raw.state)) {
    throw new Error("unexpected gh output");
  }
  const checks: PrCheck[] = (raw.statusCheckRollup ?? []).map((e) => ({
    name: (e.__typename === "StatusContext" ? e.context : e.name) ?? "",
    state: checkState(e),
    url: (e.__typename === "StatusContext" ? e.targetUrl : e.detailsUrl) || null,
  }));
  const checkSummary: Record<PrCheckState, number> = { success: 0, failure: 0, pending: 0, skipped: 0 };
  for (const c of checks) checkSummary[c.state]++;
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    isDraft: raw.isDraft === true,
    // 既知の値だけ残す。gh が将来別の値を返しても表示側で扱えない値は保存しない
    reviewDecision: REVIEW_DECISIONS.includes(raw.reviewDecision ?? "") ? (raw.reviewDecision as PrReviewDecision) : null,
    mergedAt: raw.mergedAt || null,
    headSha: typeof raw.headRefOid === "string" && /^[0-9a-f]{40}$/.test(raw.headRefOid) ? raw.headRefOid : null,
    checks,
    checkSummary,
  };
}

// gh の失敗を分類する（#55 の差分の取得も使う）
export function classify(result: Exclude<GhRunResult, { kind: "exited"; exitCode: 0 }>): { code: PrStatusErrorCode; message: string } {
  if (result.kind === "not_found") return known("GH_NOT_INSTALLED");
  if (result.kind === "timeout") return known("TIMEOUT");
  if (result.kind === "spawn_failed") return { code: "UNKNOWN" as const, message: `gh を起動できませんでした: ${result.detail}` };
  if (result.kind === "too_large") return unknown(`gh の出力が上限（${result.limitBytes / 1024 / 1024} MB）を超えました`);
  const stderr = result.stderr;
  if (result.exitCode === 4 || /gh auth login|not logged in|authentication required|bad credentials/i.test(stderr)) {
    return known("GH_AUTH");
  }
  if (/could not resolve to a (pullrequest|repository)|not found/i.test(stderr)) return known("PR_NOT_FOUND");
  if (/error connecting|dial tcp|no such host|connection refused|i\/o timeout|tls handshake|network is unreachable/i.test(stderr)) {
    return known("NETWORK");
  }
  return unknown(stderr.trim().split("\n")[0]?.slice(0, 200) || `終了コード ${result.exitCode}`);
}

export function known(code: Exclude<PrStatusErrorCode, "UNKNOWN">) {
  return { code, message: ERROR_MESSAGES[code] };
}

export function unknown(detail: string) {
  return { code: "UNKNOWN" as const, message: `取得に失敗しました: ${detail}` };
}

interface PrStatusRow {
  pr_url: string | null;
  data: string | null;
  fetched_at: string | null;
  fetched_by: string | null;
  error_url: string | null;
  error_code: PrStatusErrorCode | null;
  error_message: string | null;
  error_at: string | null;
}

function readView(db: Database, issueRowId: number, issueId: string, prUrl: string | null): PrStatusView {
  const row = db.query("SELECT * FROM pr_statuses WHERE issue_id = ?").get(issueRowId) as PrStatusRow | null;
  const view: PrStatusView = { issueId, prUrl, status: null, fetchError: null };
  if (!row || prUrl === null) return view;
  if (row.data && row.pr_url === prUrl) {
    // headSha を持たない以前の結果（#55 より前）は null にそろえる
    view.status = { prUrl, headSha: null, ...JSON.parse(row.data), fetchedAt: row.fetched_at ?? "", fetchedBy: row.fetched_by ?? "" };
  }
  if (row.error_code && row.error_url === prUrl) {
    view.fetchError = { code: row.error_code, message: row.error_message ?? "", at: row.error_at ?? "" };
  }
  return view;
}

// 現在の PR を付けた日時。PR 連動（#66）は、これ以降に一度でも in_review になった Issue を進めない
export function markPrLinked(ctx: OpCtx, issueRowId: number): void {
  ctx.db.query("UPDATE issues SET pr_linked_at = ? WHERE id = ?").run(now(), issueRowId);
}

// 作業中に PR（draft を含む）を Issue に紐付ける（nod issue link-pr）。ステータスは変えない。LLM も使える。
// PR 連動が有効な Workspace では、紐付けたあとの更新で PR が open（draft 以外）かマージ済みなら in_review に進む
export function linkPr(ctx: OpCtx, ref: string, url: string): Issue {
  const prUrl = url.trim();
  if (!GITHUB_PR_URL_RE.test(prUrl)) {
    throw new NodError("INVALID_ARGS", `${url} は GitHub の PR URL ではありません（例: https://github.com/owner/repo/pull/12）`);
  }
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    const from = row.pr_url;
    if (setColumn(ctx, row, "pr_url", prUrl)) {
      markPrLinked(ctx, row.id);
      recordEvent(ctx.db, row.id, ctx.actor, "pr_linked", { from, to: prUrl });
    }
    return toIssue(issueRowById(ctx.db, row.id));
  });
}

export function getPrStatus(db: Database, ref: string): PrStatusView {
  const row = findIssueRow(db, ref);
  return readView(db, row.id, formatIssueId(row.ws_key, row.number), row.pr_url);
}

// 同じ DB 接続・同じ Issue・同じ PR URL の取得中の更新は1本にまとめ、gh を重ねて実行しない。
// 取得中に PR URL が変わったら、新しい URL は別に取得する
const inflight = new WeakMap<Database, Map<string, Promise<PrStatusView>>>();

// gh pr view で PR の状態を取得して保存する（GitHub へは読み取りのみ）。
// 取得の失敗は例外にせず fetchError として保存・返却し、前回の成功結果は残す。アクティビティ・通知には残さない。
// Workspace で PR 連動（#66）が有効なら、保存と同じ transaction で in_progress の Issue を in_review に進め、その記録を autoTransition で返す
export function refreshPrStatus(ctx: OpCtx, ref: string, run: GhRunner = ghRunner): Promise<PrStatusView> {
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
      const autoTransition = await fetchAndSave(ctx, row.id, prUrl, run);
      return { ...getPrStatus(ctx.db, issueId), autoTransition };
    } finally {
      byIssue.delete(key);
    }
  })();
  byIssue.set(key, job);
  return job;
}

async function fetchAndSave(ctx: OpCtx, issueRowId: number, prUrl: string, run: GhRunner): Promise<AutoTransition | null> {
  const startedAt = now();
  let outcome: { data: Omit<PrStatus, "prUrl" | "fetchedAt" | "fetchedBy"> } | { error: { code: PrStatusErrorCode; message: string } };
  if (!GITHUB_PR_URL_RE.test(prUrl)) {
    outcome = { error: known("INVALID_URL") };
  } else {
    const result = await run(["pr", "view", prUrl, "--json", GH_FIELDS], { timeoutMs: PR_STATUS_TIMEOUT_MS, maxStdoutBytes: GH_OUTPUT_MAX_BYTES });
    if (result.kind === "exited" && result.exitCode === 0) {
      try {
        outcome = { data: parseGhPrView(result.stdout) };
      } catch {
        outcome = { error: unknown("gh の出力を解釈できませんでした") };
      }
    } else {
      outcome = { error: classify(result as Exclude<GhRunResult, { kind: "exited"; exitCode: 0 }>) };
    }
  }
  const at = now();
  return tx(ctx.db, () => {
    // 取得中に Issue の PR URL が変わっていたら、古い URL の結果は書かない（新しい URL の結果を上書きしない）
    const current = ctx.db.query("SELECT pr_url FROM issues WHERE id = ?").get(issueRowId) as { pr_url: string | null } | null;
    if (current?.pr_url !== prUrl) return null;
    // 保存済みより後に始めた取得のときだけ書く（別プロセスの新しい結果を古い結果で上書きしない）
    if ("data" in outcome) {
      const { changes } = ctx.db
        .query(
          `INSERT INTO pr_statuses (issue_id, pr_url, data, fetched_at, fetched_by, started_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (issue_id) DO UPDATE SET pr_url = excluded.pr_url, data = excluded.data,
             fetched_at = excluded.fetched_at, fetched_by = excluded.fetched_by, started_at = excluded.started_at,
             error_url = NULL, error_code = NULL, error_message = NULL, error_at = NULL
           WHERE excluded.started_at >= pr_statuses.started_at`,
        )
        .run(issueRowId, prUrl, JSON.stringify(outcome.data), at, ctx.actor, startedAt);
      // 新しい結果を保存できたときだけ評価する（古い取得の結果では進めない）
      return changes > 0 ? applyPrReview(ctx, issueRowId) : null;
    } else {
      ctx.db
        .query(
          `INSERT INTO pr_statuses (issue_id, error_url, error_code, error_message, error_at, started_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (issue_id) DO UPDATE SET error_url = excluded.error_url, error_code = excluded.error_code,
             error_message = excluded.error_message, error_at = excluded.error_at, started_at = excluded.started_at
           WHERE excluded.started_at >= pr_statuses.started_at`,
        )
        .run(issueRowId, prUrl, outcome.error.code, outcome.error.message, at, startedAt);
      return null;
    }
  });
}
