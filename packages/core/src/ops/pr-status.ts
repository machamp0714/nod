import type { Database } from "bun:sqlite";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { findIssueRow, formatIssueId } from "../issue-query";
import type {
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
  | { kind: "timeout" }; // 時間切れで止めた
export type GhRunner = (args: string[], opts: { timeoutMs: number }) => Promise<GhRunResult>;

export const PR_STATUS_TIMEOUT_MS = 15_000;
// 時間切れで SIGTERM を送ってから SIGKILL するまでの猶予
export const GH_KILL_GRACE_MS = 2_000;
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

// コマンドを起動して結果を返す。prefix は gh の前に置く引数（テストで bun スクリプトを gh の代わりにするため）。
// 時間切れになったら出力や終了を待たずに timeout を返し、SIGTERM → 猶予 → SIGKILL で止める
export function createCommandRunner(command: string, prefix: string[] = [], opts: { killGraceMs?: number } = {}): GhRunner {
  const killGraceMs = opts.killGraceMs ?? GH_KILL_GRACE_MS;
  return async (args, { timeoutMs }) => {
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn([command, ...prefix, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // 対話の確認を出させない。認証は gh 自身に任せ、nod はトークンを読まない
        env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === "ENOENT") return { kind: "not_found" };
      return { kind: "spawn_failed", detail: err.code ?? err.message ?? String(e) };
    }
    const collected: Promise<GhRunResult> = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, exitCode]) => ({ kind: "exited", exitCode, stdout, stderr }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<GhRunResult>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    });
    try {
      const result = await Promise.race([collected, timedOut]);
      if (result.kind === "timeout") {
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

export function getPrStatus(db: Database, ref: string): PrStatusView {
  const row = findIssueRow(db, ref);
  return readView(db, row.id, formatIssueId(row.ws_key, row.number), row.pr_url);
}

// 同じ DB 接続・同じ Issue・同じ PR URL の取得中の更新は1本にまとめ、gh を重ねて実行しない。
// 取得中に PR URL が変わったら、新しい URL は別に取得する
const inflight = new WeakMap<Database, Map<string, Promise<PrStatusView>>>();

// gh pr view で PR の状態を取得して保存する（GitHub へは読み取りのみ）。
// 取得の失敗は例外にせず fetchError として保存・返却し、前回の成功結果は残す。アクティビティ・通知には残さない
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
      await fetchAndSave(ctx, row.id, prUrl, run);
      return getPrStatus(ctx.db, issueId);
    } finally {
      byIssue.delete(key);
    }
  })();
  byIssue.set(key, job);
  return job;
}

async function fetchAndSave(ctx: OpCtx, issueRowId: number, prUrl: string, run: GhRunner): Promise<void> {
  const startedAt = now();
  let outcome: { data: Omit<PrStatus, "prUrl" | "fetchedAt" | "fetchedBy"> } | { error: { code: PrStatusErrorCode; message: string } };
  if (!GITHUB_PR_URL_RE.test(prUrl)) {
    outcome = { error: known("INVALID_URL") };
  } else {
    const result = await run(["pr", "view", prUrl, "--json", GH_FIELDS], { timeoutMs: PR_STATUS_TIMEOUT_MS });
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
  tx(ctx.db, () => {
    // 取得中に Issue の PR URL が変わっていたら、古い URL の結果は書かない（新しい URL の結果を上書きしない）
    const current = ctx.db.query("SELECT pr_url FROM issues WHERE id = ?").get(issueRowId) as { pr_url: string | null } | null;
    if (current?.pr_url !== prUrl) return;
    // 保存済みより後に始めた取得のときだけ書く（別プロセスの新しい結果を古い結果で上書きしない）
    if ("data" in outcome) {
      ctx.db
        .query(
          `INSERT INTO pr_statuses (issue_id, pr_url, data, fetched_at, fetched_by, started_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (issue_id) DO UPDATE SET pr_url = excluded.pr_url, data = excluded.data,
             fetched_at = excluded.fetched_at, fetched_by = excluded.fetched_by, started_at = excluded.started_at,
             error_url = NULL, error_code = NULL, error_message = NULL, error_at = NULL
           WHERE excluded.started_at >= pr_statuses.started_at`,
        )
        .run(issueRowId, prUrl, JSON.stringify(outcome.data), at, ctx.actor, startedAt);
    } else {
      ctx.db
        .query(
          `INSERT INTO pr_statuses (issue_id, error_url, error_code, error_message, error_at, started_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (issue_id) DO UPDATE SET error_url = excluded.error_url, error_code = excluded.error_code,
             error_message = excluded.error_message, error_at = excluded.error_at, started_at = excluded.started_at
           WHERE excluded.started_at >= pr_statuses.started_at`,
        )
        .run(issueRowId, prUrl, outcome.error.code, outcome.error.message, at, startedAt);
    }
  });
}
