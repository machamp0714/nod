import { assessCreatedIssues } from "./assessed-creation";
import { jevClient, type JevClient } from "./jev-client";
import type { Database } from "bun:sqlite";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { addComment } from "../events";
import { findIssueRow, formatIssueId } from "../issue-query";
import type { Status } from "../types";
import { AUTOMATION_LIMIT_DEFAULT, AUTOMATION_LIMIT_MAX } from "./automation";
import { GITHUB_REPO_RE } from "./github-repo";
import { ghAuthFailed } from "./github-links";
import { insertIssue } from "./issues";
import { type GhRunner, type GhRunResult, ghRunner } from "./pr-status";
import { resolveProject } from "./projects";
import { findWorkspace } from "./workspaces";

// GitHub Issues の取り込み（#77 nod import github）。gh issue list / view で読むだけで、GitHub へは書き込まない。
// 取り込んだ Issue は issue_imports に対応を残し、再実行では作り直さず、上書きもしない
export const GITHUB_IMPORT_LIMIT_DEFAULT = AUTOMATION_LIMIT_DEFAULT;
export const GITHUB_IMPORT_LIMIT_MAX = AUTOMATION_LIMIT_MAX;
// 最大 500 件の本文を1回で読むので、PR の状態（15秒・5MB）より長く・大きく取る
export const GITHUB_IMPORT_LIST_TIMEOUT_MS = 60_000;
export const GITHUB_IMPORT_VIEW_TIMEOUT_MS = 30_000;
export const GITHUB_IMPORT_MAX_BYTES = 50 * 1024 * 1024;
export const GITHUB_IMPORT_STATES = ["open", "all"] as const;
export type GithubImportState = (typeof GITHUB_IMPORT_STATES)[number];
// open の Issue の取り込み先。既定は Triage（受け入れは人が1件ずつ決める）
export const GITHUB_IMPORT_OPEN_STATUSES = ["triage", "backlog", "todo"] as const;
export type GithubImportOpenStatus = (typeof GITHUB_IMPORT_OPEN_STATUSES)[number];

const LIST_FIELDS = "number,title,body,state,stateReason,labels,assignees,author,createdAt,closedAt,url";
const ISSUE_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;

export interface GithubImportOptions {
  dryRun?: boolean;
  state?: GithubImportState;
  labels?: string[]; // gh issue list --label（すべてのラベルを持つ Issue に絞る）
  limit?: number;
  openStatus?: GithubImportOpenStatus;
  projectRef?: string;
}

export interface GithubImportItem {
  number: number;
  sourceKey: string; // owner/repo#123（owner/repo は小文字）
  url: string;
  title: string;
  state: "OPEN" | "CLOSED";
  stateReason: string | null;
  status: Status; // 取り込むときの nod のステータス
  labels: string[];
  assignees: string[];
  author: string;
  createdAt: string;
  closedAt: string | null;
  existing: string | null; // 取り込み済みなら nod の Issue ID
  deleted: boolean; // 取り込んだ後に nod で永久削除した、または紐付けを外した（再取り込みしない）
}

export interface GithubImportResult {
  workspaceKey: string;
  repo: string;
  state: GithubImportState;
  dryRun: boolean;
  project: string | null;
  truncated: boolean; // --limit に達した（それより古い Issue は読んでいない）
  items: GithubImportItem[];
  imported: { sourceKey: string; id: string }[];
  skipped: { sourceKey: string; id: string }[]; // 取り込み済み
  deleted: { sourceKey: string }[]; // 取り込んだ後に永久削除した、または紐付けを外したので取り込まない
  failed: { sourceKey: string; message: string }[];
}

interface GhListIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  stateReason?: string | null;
  labels?: { name: string }[] | null;
  assignees?: { login: string }[] | null;
  author?: { login: string } | null;
  createdAt: string;
  closedAt?: string | null;
  url: string;
}

interface GhComment {
  author?: { login: string } | null;
  body: string;
  createdAt: string;
}

function validate(repo: string, o: GithubImportOptions): void {
  if (!GITHUB_REPO_RE.test(repo)) throw new NodError("INVALID_ARGS", `${repo} は owner/repo の形ではありません（例: machamp0714/nod）`);
  if (o.limit !== undefined && (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > GITHUB_IMPORT_LIMIT_MAX)) {
    throw new NodError("INVALID_ARGS", `--limit は 1〜${GITHUB_IMPORT_LIMIT_MAX} の整数で指定してください`);
  }
  if (o.state !== undefined && !GITHUB_IMPORT_STATES.includes(o.state)) {
    throw new NodError("INVALID_ARGS", `--state は ${GITHUB_IMPORT_STATES.join("|")} のどれかで指定してください`);
  }
  if (o.openStatus !== undefined && !GITHUB_IMPORT_OPEN_STATUSES.includes(o.openStatus)) {
    throw new NodError("INVALID_ARGS", `--open-status は ${GITHUB_IMPORT_OPEN_STATUSES.join("|")} のどれかで指定してください`);
  }
  for (const label of o.labels ?? []) {
    if (!label.trim()) throw new NodError("INVALID_ARGS", "--label には空でないラベル名を指定してください");
  }
}

function ghError(result: Exclude<GhRunResult, { kind: "exited"; exitCode: 0 }>, what: string): NodError {
  switch (result.kind) {
    case "not_found":
      return new NodError("GH_NOT_INSTALLED", "gh が見つかりません。GitHub CLI を導入してください");
    case "spawn_failed":
      return new NodError("GH_FAILED", `gh を起動できませんでした: ${result.detail}`);
    case "timeout":
      return new NodError("GH_FAILED", `${what}が時間内に終わりませんでした`);
    case "too_large":
      return new NodError("GH_FAILED", `${what}の出力が大きすぎます（${result.limitBytes} バイト超）。--limit か --label で絞ってください`);
    case "exited": {
      const stderr = result.stderr;
      if (ghAuthFailed(stderr, result.exitCode)) {
        return new NodError("GH_AUTH", "gh が未認証です。gh auth login を実行してください");
      }
      if (/could not resolve to a repository/i.test(stderr)) {
        return new NodError("NOT_FOUND", "リポジトリが見つかりません（名前の誤りかアクセス権なし）");
      }
      const detail = stderr.trim().split("\n")[0]?.slice(0, 200) || `終了コード ${result.exitCode}`;
      return new NodError("GH_FAILED", `${what}に失敗しました: ${detail}`);
    }
  }
}

async function runGhJson<T>(run: GhRunner, args: string[], timeoutMs: number, what: string): Promise<T> {
  const result = await run(args, { timeoutMs, maxStdoutBytes: GITHUB_IMPORT_MAX_BYTES });
  if (result.kind !== "exited" || result.exitCode !== 0) throw ghError(result as Parameters<typeof ghError>[0], what);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new NodError("GH_FAILED", `${what}の出力を読めませんでした`);
  }
}

// GitHub は owner/repo の大文字小文字を区別しないので、対応表のキーは小文字にそろえる。gh が返す URL を正とする
function sourceKeyOf(issue: GhListIssue, repo: string): string {
  const m = ISSUE_URL_RE.exec(issue.url);
  const ownerRepo = m ? `${m[1]}/${m[2]}` : repo;
  return `${ownerRepo.toLowerCase()}#${issue.number}`;
}

// やらないと決めて close した理由。これだけを canceled にし、COMPLETED・理由なし（古い Issue など）は done にする
const CANCELED_STATE_REASONS = ["NOT_PLANNED", "DUPLICATE"];

// open は指定のステータス、closed は NOT_PLANNED・DUPLICATE なら canceled、それ以外は done
function statusOf(issue: GhListIssue, openStatus: GithubImportOpenStatus): Status {
  if (issue.state !== "CLOSED") return openStatus;
  return CANCELED_STATE_REASONS.includes(issue.stateReason ?? "") ? "canceled" : "done";
}

// 対応表の行。取り込み済みなら nod の Issue ID、永久削除済みなら id が null
function existingIssue(db: Database, workspaceId: number, sourceKey: string): { id: string | null } | null {
  const row = db
    .query(
      `SELECT w.key, i.number FROM issue_imports m LEFT JOIN issues i ON i.id = m.issue_id LEFT JOIN workspaces w ON w.id = i.workspace_id
       WHERE m.workspace_id = ? AND m.source = 'github' AND m.source_key = ?`,
    )
    .get(workspaceId, sourceKey) as { key: string | null; number: number | null } | null;
  if (!row) return null;
  return { id: row.key !== null && row.number !== null ? formatIssueId(row.key, row.number) : null };
}

// 本文の末尾に、取り込み元と nod に写さない情報（作成者・日時・GitHub の担当）を残す
function descriptionOf(item: GithubImportItem, body: string): string {
  const origin = [`取り込み元: ${item.url}（GitHub #${item.number}、@${item.author} が ${item.createdAt} に作成`];
  if (item.closedAt) origin.push(`、${item.closedAt} に close`);
  origin.push("）");
  const lines = [origin.join("")];
  if (item.assignees.length) lines.push(`担当（GitHub）: ${item.assignees.map((a) => `@${a}`).join(", ")}`);
  const footer = `---\n${lines.join("\n")}`;
  return body.trim() ? `${body}\n\n${footer}` : footer;
}

function toItem(db: Database, workspaceId: number, repo: string, issue: GhListIssue, openStatus: GithubImportOpenStatus): GithubImportItem {
  const sourceKey = sourceKeyOf(issue, repo);
  const existing = existingIssue(db, workspaceId, sourceKey);
  return {
    number: issue.number,
    sourceKey,
    url: issue.url,
    title: issue.title,
    state: issue.state === "CLOSED" ? "CLOSED" : "OPEN",
    stateReason: issue.stateReason || null,
    status: statusOf(issue, openStatus),
    labels: (issue.labels ?? []).map((l) => l.name),
    assignees: (issue.assignees ?? []).map((a) => a.login),
    author: issue.author?.login ?? "ghost",
    createdAt: issue.createdAt,
    closedAt: issue.closedAt || null,
    existing: existing?.id ?? null,
    deleted: existing !== null && existing.id === null,
  };
}

// 1件分を1つの transaction で書く。Issue・コメント・対応表のどれかで失敗したら、その Issue は何も残さない
function writeOne(
  ctx: OpCtx,
  workspaceId: number,
  projectId: number | null,
  item: GithubImportItem,
  body: string,
  comments: GhComment[],
): { created: true; id: string } | { created: false; id: string | null } {
  return tx(ctx.db, () => {
    // 読んでから書くまでに別の実行が取り込んだかもしれないので、書く transaction の中で確かめ直す
    const existing = existingIssue(ctx.db, workspaceId, item.sourceKey);
    if (existing) return { id: existing.id, created: false };
    const origin: Record<string, string> = { imported_from: item.url, github_created_at: item.createdAt };
    if (item.closedAt) origin.github_closed_at = item.closedAt;
    const issue = insertIssue(ctx, {
      workspaceId,
      title: item.title,
      description: descriptionOf(item, body),
      priority: 0,
      estimate: null,
      dueDate: null,
      parentId: null,
      projectId,
      labels: item.labels,
      // 閉じた Issue は状態の遷移を経ず、最初から done・canceled で作る（closed_at は取り込んだ時刻）。
      // created の event の status が done・canceled なので、完了数（stats）と要約の完了・キャンセルには数えない
      status: item.status,
      closeReason: item.status === "canceled" ? `GitHub で close（${item.stateReason}）` : null,
      origin,
    });
    const row = findIssueRow(ctx.db, issue.id);
    for (const c of comments) {
      addComment(ctx, row, `@${c.author?.login ?? "ghost"} が GitHub でコメント（${c.createdAt}）\n\n${c.body}`);
    }
    ctx.db
      .query("INSERT INTO issue_imports (workspace_id, source, source_key, issue_id, imported_by, imported_at) VALUES (?, 'github', ?, ?, ?, ?)")
      .run(workspaceId, item.sourceKey, row.id, ctx.actor, now());
    return { id: issue.id, created: true };
  });
}

// gh issue list で読み、dry-run なら対応の提案だけを返す。実行は人だけで、1件ずつ gh issue view でコメントを読んでから書く
export async function importGithubIssues(
  ctx: OpCtx,
  keyOrPath: string,
  repo: string,
  opts: GithubImportOptions = {},
  run: GhRunner = ghRunner,
  client: JevClient = jevClient,
): Promise<GithubImportResult> {
  validate(repo, opts);
  const dryRun = opts.dryRun ?? false;
  const state = opts.state ?? "open";
  const limit = opts.limit ?? GITHUB_IMPORT_LIMIT_DEFAULT;
  const openStatus = opts.openStatus ?? "triage";
  const workspace = findWorkspace(ctx.db, keyOrPath);
  if (!workspace) throw new NodError("NOT_FOUND", `Workspace ${keyOrPath} は登録されていません`);
  const project = opts.projectRef ? resolveProject(ctx.db, opts.projectRef) : null;
  if (!dryRun && isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は nod import github を実行できません（--dry-run での確認はできます）。実行は me に依頼してください");
  }
  const args = ["issue", "list", "-R", repo, "--state", state, "--limit", String(limit), "--json", LIST_FIELDS];
  // ラベル名が - で始まっても gh のオプションと取り違えないよう = でつなぐ
  for (const label of opts.labels ?? []) args.push(`--label=${label}`);
  const listed = await runGhJson<GhListIssue[]>(run, args, GITHUB_IMPORT_LIST_TIMEOUT_MS, "gh issue list");
  if (!Array.isArray(listed)) throw new NodError("GH_FAILED", "gh issue list の出力を読めませんでした");
  // gh は新しい順に返す。nod の連番が GitHub の順になるよう、古い番号から扱う
  const sorted = [...listed].sort((a, b) => a.number - b.number);
  const bodies = new Map(sorted.map((i) => [i.number, i.body ?? ""]));
  const result: GithubImportResult = {
    workspaceKey: workspace.key,
    repo,
    state,
    dryRun,
    project: project?.name ?? null,
    truncated: listed.length >= limit,
    items: sorted.map((i) => toItem(ctx.db, workspace.id, repo, i, openStatus)),
    imported: [],
    skipped: [],
    deleted: [],
    failed: [],
  };
  if (dryRun) return result;
  // 1件ごとに確定し、途中で失敗しても残りを続ける。失敗した件は対応表に残らないので、再実行で取り込み直せる
  for (const item of result.items) {
    if (item.existing) {
      result.skipped.push({ sourceKey: item.sourceKey, id: item.existing });
      continue;
    }
    if (item.deleted) {
      result.deleted.push({ sourceKey: item.sourceKey });
      continue;
    }
    try {
      const view = await runGhJson<{ comments?: GhComment[] }>(
        run,
        ["issue", "view", String(item.number), "-R", repo, "--json", "comments"],
        GITHUB_IMPORT_VIEW_TIMEOUT_MS,
        `gh issue view ${item.number}`,
      );
      const comments = [...(view.comments ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const written = writeOne(ctx, workspace.id, project?.id ?? null, item, bodies.get(item.number) ?? "", comments);
      if (written.created) result.imported.push({ sourceKey: item.sourceKey, id: written.id });
      else if (written.id) result.skipped.push({ sourceKey: item.sourceKey, id: written.id });
      else result.deleted.push({ sourceKey: item.sourceKey });
    } catch (e) {
      result.failed.push({ sourceKey: item.sourceKey, message: e instanceof Error ? e.message : String(e) });
    }
  }
  await assessCreatedIssues(ctx, result.imported.map(i => i.id), client);
  return result;
}
