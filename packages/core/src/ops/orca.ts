import type { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import type { OpCtx } from "../ctx";
import { worktreeNameFor } from "../branch-naming";
import { tx } from "../db";
import { NodError } from "../errors";
import { findIssueRow, findWritableIssueRow, formatIssueId, type IssueRow } from "../issue-query";
import { setColumn } from "../mutate";
import type { OrcaAgent, OrcaFailure, OrcaFailureCode, OrcaOpenResult, OrcaTerminal, OrcaWorktreeResult } from "../types";
import { parseOrcaAgent } from "./workspaces";
import { createCommandRunner, type GhRunner, type GhRunResult } from "./pr-status";

// orca の実行結果は gh と同じ形で受け取る。テストと e2e は実際の orca を起動しないスタブを渡す
export type OrcaRunner = GhRunner;

export const ORCA_TIMEOUT_MS = 15_000;
// worktree の作成とエージェントの起動は時間がかかるため、専用に長く待つ（#210）
export const ORCA_CREATE_TIMEOUT_MS = 60_000;
const ORCA_OUTPUT_MAX_BYTES = 1024 * 1024;

// ORCA_CLI_COMMAND が実在するファイルなら空白を含んでもそのまま使い、そうでなければ空白で区切る
export function orcaCommand(value: string | undefined): string[] {
  if (!value) return ["orca"];
  if (existsSync(value)) return [value];
  return value.split(" ").filter(Boolean);
}

// NOD_ORCA=0 なら null（orca を使わない）。呼ぶたびに環境変数を読む
export function defaultOrcaRunner(env: Record<string, string | undefined> = process.env): OrcaRunner | null {
  if (env.NOD_ORCA === "0") return null;
  const [command, ...prefix] = orcaCommand(env.ORCA_CLI_COMMAND);
  return createCommandRunner(command ?? "orca", prefix);
}

const FAILURE_MESSAGES: Record<Exclude<OrcaFailureCode, "TIMEOUT">, string> = {
  DISABLED: "Orca との連携が無効です（NOD_ORCA=0）",
  NO_WORKTREE: "この Issue には実行場所（worktree）が記録されていません",
  WORKTREE_ALREADY_RECORDED: "この Issue には実行場所（worktree かブランチ）が記録済みです",
  WORKTREE_CREATING: "この Issue の worktree は作成中です。終わるまで待ってください",
  WORKTREE_NOT_RECORDED: "worktree は作られましたが、Issue に記録できませんでした",
  ORCA_NOT_INSTALLED: "orca が見つかりません。Orca を起動し、orca CLI を使えるようにしてください",
  WORKTREE_NOT_IN_ORCA: "この worktree は Orca に登録されていません",
  NO_TERMINAL: "この worktree に Orca の端末がありません",
  TERMINAL_NOT_FOUND: "指定した端末はこの worktree にありません。宛先を選び直してください",
  ORCA_ERROR: "orca の実行に失敗しました",
};

// timeoutMs は TIMEOUT の文言に出す待ち時間（省くと ORCA_TIMEOUT_MS）
export function orcaFailure(code: OrcaFailureCode, detail?: string, timeoutMs: number = ORCA_TIMEOUT_MS): OrcaFailure {
  const base = code === "TIMEOUT" ? `${timeoutMs / 1000}秒以内に orca が応答しませんでした` : FAILURE_MESSAGES[code];
  return { code, message: detail ? `${base}: ${detail}` : base };
}

// シェルに貼って使えるよう、単一引用符で囲む
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function cdCommand(worktree: string): string {
  return `cd ${shellQuote(worktree)}`;
}

type Envelope = { ok: true; result: unknown } | { ok: false; failure: OrcaFailure };

// orca の --json 出力（{ ok, result } か { ok: false, error: { code, message } }）を読む。
// timeoutMs は時間切れの文言に出す待ち時間（省くと ORCA_TIMEOUT_MS）
export function readOrcaEnvelope(r: GhRunResult, timeoutMs: number = ORCA_TIMEOUT_MS): Envelope {
  if (r.kind === "not_found") return { ok: false, failure: orcaFailure("ORCA_NOT_INSTALLED") };
  if (r.kind === "timeout") return { ok: false, failure: orcaFailure("TIMEOUT", undefined, timeoutMs) };
  if (r.kind === "spawn_failed") return { ok: false, failure: orcaFailure("ORCA_ERROR", r.detail) };
  if (r.kind === "too_large") return { ok: false, failure: orcaFailure("ORCA_ERROR", "出力が大きすぎます") };
  let parsed: { ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } } | null = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = null;
  }
  if (parsed && parsed.ok === false) {
    const code = typeof parsed.error?.code === "string" ? parsed.error.code : "";
    const message = typeof parsed.error?.message === "string" ? parsed.error.message : code;
    if (code === "selector_not_found") return { ok: false, failure: orcaFailure("WORKTREE_NOT_IN_ORCA") };
    if (code === "terminal_handle_stale" || code === "terminal_not_found") {
      return { ok: false, failure: orcaFailure("TERMINAL_NOT_FOUND") };
    }
    return { ok: false, failure: orcaFailure("ORCA_ERROR", message || undefined) };
  }
  if (r.exitCode !== 0 || !parsed) {
    const detail = r.stderr.trim().split("\n")[0] || `終了コード ${r.exitCode}`;
    return { ok: false, failure: orcaFailure("ORCA_ERROR", detail) };
  }
  return { ok: true, result: parsed.result };
}

interface RawTerminal {
  handle?: unknown;
  title?: unknown;
  agentIdentity?: unknown;
  worktreePath?: unknown;
  connected?: unknown;
  writable?: unknown;
  orphaned?: unknown;
}

function toTerminal(t: RawTerminal): OrcaTerminal | null {
  if (typeof t.handle !== "string" || !t.handle) return null;
  return {
    handle: t.handle,
    title: typeof t.title === "string" ? t.title : "",
    agentIdentity: typeof t.agentIdentity === "string" && t.agentIdentity ? t.agentIdentity : null,
    worktreePath: typeof t.worktreePath === "string" ? t.worktreePath : null,
    live: t.connected !== false && t.writable !== false && t.orphaned !== true,
  };
}

// worktree の Orca の端末を一覧する。失敗は OrcaFailure で返し、例外にしない
export async function listOrcaTerminals(
  run: OrcaRunner | null,
  worktree: string,
): Promise<{ terminals: OrcaTerminal[] } | { failure: OrcaFailure }> {
  if (!run) return { failure: orcaFailure("DISABLED") };
  const res = readOrcaEnvelope(
    await run(["terminal", "list", "--worktree", `path:${worktree}`, "--json"], {
      timeoutMs: ORCA_TIMEOUT_MS,
      maxStdoutBytes: ORCA_OUTPUT_MAX_BYTES,
    }),
  );
  if (!res.ok) return { failure: res.failure };
  const raw = (res.result as { terminals?: unknown } | null)?.terminals;
  const terminals = (Array.isArray(raw) ? raw : [])
    .map((t) => toTerminal(t as RawTerminal))
    .filter((t): t is OrcaTerminal => t !== null)
    // 別の worktree（入れ子の worktree など）の端末は宛先にしない
    .filter((t) => t.worktreePath === null || samePath(t.worktreePath, worktree));
  return { terminals };
}

// シンボリックリンク（macOS の /tmp → /private/tmp など）と末尾のスラッシュの違いを無視して比べる
function normalizePath(path: string): string {
  let resolved = path;
  try {
    resolved = realpathSync(path);
  } catch {
    // この機械に無いパスはそのまま比べる
  }
  return resolved.length > 1 ? resolved.replace(/\/+$/, "") || "/" : resolved;
}

export function samePath(a: string, b: string): boolean {
  return a === b || normalizePath(a) === normalizePath(b);
}

// 稼働中の LLM の端末（エージェントが動いていて、書き込める端末）
export function agentTerminals(terminals: OrcaTerminal[]): OrcaTerminal[] {
  return terminals.filter((t) => t.live && t.agentIdentity !== null);
}

// 前面に出す端末。LLM の端末を優先し、無ければ書き込める端末、それも無ければ最初の端末
function pickTerminal(terminals: OrcaTerminal[]): OrcaTerminal | null {
  return agentTerminals(terminals)[0] ?? terminals.find((t) => t.live) ?? terminals[0] ?? null;
}

// 記録済みの worktree を Orca の画面で前面に出す（#52）。セッションの起動・再開はしない。
// DB は変えない。開けなかったときは理由と、手で開くためのパスとコマンドを返す
export async function openInOrca(db: Database, ref: string, run: OrcaRunner | null): Promise<OrcaOpenResult> {
  const row = findIssueRow(db, ref);
  const issueId = formatIssueId(row.ws_key, row.number);
  const worktree = row.worktree;
  const fail = (failure: OrcaFailure): OrcaOpenResult => ({
    issueId,
    opened: false,
    worktree,
    copyCommand: worktree ? cdCommand(worktree) : null,
    terminal: null,
    failure,
  });
  if (!worktree) return fail(orcaFailure("NO_WORKTREE"));
  const listed = await listOrcaTerminals(run, worktree);
  if ("failure" in listed) return fail(listed.failure);
  const terminal = pickTerminal(listed.terminals);
  if (!terminal || !run) return fail(orcaFailure("NO_TERMINAL"));
  const switched = readOrcaEnvelope(
    await run(["terminal", "switch", "--terminal", terminal.handle, "--json"], {
      timeoutMs: ORCA_TIMEOUT_MS,
      maxStdoutBytes: ORCA_OUTPUT_MAX_BYTES,
    }),
  );
  if (!switched.ok) return fail(switched.failure);
  return { issueId, opened: true, worktree, copyCommand: cdCommand(worktree), terminal, failure: null };
}

const FEATURE_RE = /^[a-z0-9-]+$/;

// 「Orca で作業を始める」で作られる worktree 名（Web のプレビュー用。hash を Web で計算しないため）。空の feature は省略形になる
export function getWorktreeName(db: Database, ref: string, feature: string): { issueId: string; name: string } {
  if (feature !== "" && !FEATURE_RE.test(feature)) {
    throw new NodError("INVALID_ARGS", "feature は英小文字・数字・- だけで指定してください");
  }
  const row = findIssueRow(db, ref);
  return { issueId: formatIssueId(row.ws_key, row.number), name: worktreeNameFor(db, row, feature) };
}

// worktree を作成中の Issue（DB ごとの Issue の内部 ID）。記録済みの確認は orca を呼ぶ前に行うため、
// orca を待つ間（最長 60 秒）に来た同じ Issue への要求をここで止める。server は1プロセスなので、プロセス内の印で足りる
const creating = new WeakMap<Database, Set<number>>();

// Issue の worktree を Orca に作り、エージェントのセッションを起動する（#210）。着手の指示（--prompt）は送らず、何をさせるかは人が決める。
// エージェントは input.agent（作成時の選択）、無ければ Workspace の既定。
// 成功したら worktree とブランチを Issue に記録する。ステータスと担当は変えない。
// 実行場所（worktree かブランチ）が記録済みの Issue では作らない（二重作成の防止）。作れなかった理由は OrcaFailure で返し、Issue は変えない
export async function createOrcaWorktree(
  ctx: OpCtx,
  ref: string,
  input: { feature: string; agent?: string },
  run: OrcaRunner | null,
): Promise<OrcaWorktreeResult> {
  const row = findWritableIssueRow(ctx.db, ref);
  const issueId = formatIssueId(row.ws_key, row.number);
  if (!FEATURE_RE.test(input.feature)) {
    throw new NodError("INVALID_ARGS", "feature は英小文字・数字・- だけで指定してください");
  }
  const chosen = input.agent === undefined ? null : parseOrcaAgent(input.agent);
  const fail = (failure: OrcaFailure): OrcaWorktreeResult => ({ issueId, created: false, worktree: row.worktree, branch: row.branch, failure });
  // ブランチだけが記録済みの Issue（古いデータ）でも作らない。作ると記録済みのブランチ名を上書きしてしまう
  if (row.worktree || row.branch) return fail(orcaFailure("WORKTREE_ALREADY_RECORDED"));
  if (!run) return fail(orcaFailure("DISABLED"));
  const inFlight = creating.get(ctx.db) ?? new Set<number>();
  creating.set(ctx.db, inFlight);
  if (inFlight.has(row.id)) return fail(orcaFailure("WORKTREE_CREATING"));
  inFlight.add(row.id);
  try {
    return await createAndRecord(ctx, ref, row, issueId, input.feature, chosen, run, fail);
  } finally {
    inFlight.delete(row.id);
  }
}

async function createAndRecord(
  ctx: OpCtx,
  ref: string,
  row: IssueRow,
  issueId: string,
  feature: string,
  chosen: OrcaAgent | null,
  run: OrcaRunner,
  fail: (failure: OrcaFailure) => OrcaWorktreeResult,
): Promise<OrcaWorktreeResult> {
  const workspace = ctx.db.query("SELECT path, default_agent FROM workspaces WHERE id = ?").get(row.workspace_id) as { path: string; default_agent: OrcaAgent };
  const agent = chosen ?? workspace.default_agent;
  const res = readOrcaEnvelope(
    await run(
      ["worktree", "create", "--repo", `path:${workspace.path}`, "--name", worktreeNameFor(ctx.db, row, feature), "--no-parent", "--agent", agent, "--activate", "--json"],
      { timeoutMs: ORCA_CREATE_TIMEOUT_MS, maxStdoutBytes: ORCA_OUTPUT_MAX_BYTES },
    ),
    ORCA_CREATE_TIMEOUT_MS,
  );
  if (!res.ok) return fail(res.failure);
  const raw = (res.result as { worktree?: { path?: unknown; branch?: unknown } } | null)?.worktree;
  if (typeof raw?.path !== "string" || !raw.path) return fail(orcaFailure("ORCA_ERROR", "結果から worktree のパスを読めません"));
  const worktree = raw.path;
  const branch = typeof raw.branch === "string" && raw.branch ? raw.branch.replace(/^refs\/heads\//, "") : null;
  return tx(ctx.db, () => {
    // orca を待つ間に変わっているかもしれないため、読み直してから記録する
    const current = findIssueRow(ctx.db, ref);
    // 待つ間にアーカイブされたら記録できない。作られた worktree を手で片付けられるよう、パスを理由に含めて返す
    if (current.archived_at !== null) {
      return fail(orcaFailure("WORKTREE_NOT_RECORDED", `${issueId} はアーカイブ済みです（作られた worktree: ${worktree}）`));
    }
    setColumn(ctx, current, "branch", branch);
    setColumn(ctx, current, "worktree", worktree);
    return { issueId, created: true, worktree, branch, failure: null };
  });
}
