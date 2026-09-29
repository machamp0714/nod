import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { recordEvent } from "../events";
import { findWritableIssueRow, type IssueRow } from "../issue-query";
import {
  DOC_KINDS,
  type DocKind,
  type DocumentContent,
  type DocumentDetail,
  type DocumentIssueLink,
  type DocumentProjectLink,
  type DocumentRef,
  type DocumentSummary,
} from "../types";
import { resolveProject } from "./projects";

export function documentTitle(path: string, content: string): string {
  const m = /^#\s+(.+?)\s*$/m.exec(content);
  return m?.[1] ?? basename(path);
}

export function readDocumentFile(path: string, cwd: string = process.cwd()): { abs: string; content: string } {
  const abs = resolve(cwd, path);
  if (!existsSync(abs)) throw new NodError("FILE_NOT_FOUND", `${abs} が見つかりません`);
  return { abs, content: readFileSync(abs, "utf8") };
}

export interface DocTarget {
  issueRef?: string;
  projectRef?: string;
}

export interface ResolvedTarget {
  issue?: IssueRow;
  projectId?: number;
}

export function resolveDocTarget(db: Database, target: DocTarget): ResolvedTarget {
  if (Boolean(target.issueRef) === Boolean(target.projectRef)) {
    throw new NodError("INVALID_ARGS", "添付先には Issue か Project のどちらか一方を指定してください");
  }
  return target.issueRef
    ? { issue: findWritableIssueRow(db, target.issueRef) }
    : { projectId: resolveProject(db, target.projectRef as string).id };
}

function realPathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path).normalize("NFC");
  } catch {
    return null;
  }
}

// 同じ実体を指す登録済みの Document を探す。パスの完全一致のほか、大文字小文字や Unicode 正規化（NFC/NFD）
// だけ違うパスは、実パスが同じときに限り同じものとみなす（大文字小文字を区別する FS では別ファイルのまま）
function findDocumentByPath(db: Database, path: string): DocumentRef | null {
  const exact = db.query("SELECT id, path, title, kind FROM documents WHERE path = ?").get(path) as DocumentRef | null;
  if (exact) return exact;
  const key = (p: string) => p.normalize("NFC").toLowerCase();
  const candidates = (db.query("SELECT id, path, title, kind FROM documents").all() as DocumentRef[]).filter(
    (doc) => key(doc.path) === key(path),
  );
  if (candidates.length === 0) return null;
  const real = realPathOrNull(path);
  return (
    candidates.find((doc) => (real === null ? doc.path.normalize("NFC") === path.normalize("NFC") : realPathOrNull(doc.path) === real)) ??
    null
  );
}

// パスで Document を登録する。登録済みなら、指定したタイトルと種類だけを更新する。
// 同じ実体を別の表記で指したときは、パスを今回の表記に合わせる
function upsertDocument(
  ctx: OpCtx,
  input: { path: string; content: string; title?: string; kind?: DocKind },
): DocumentRef {
  const existing = findDocumentByPath(ctx.db, input.path);
  if (existing) {
    const doc = { ...existing, path: input.path, title: input.title ?? existing.title, kind: input.kind ?? existing.kind };
    ctx.db.query("UPDATE documents SET path = ?, title = ?, kind = ? WHERE id = ?").run(doc.path, doc.title, doc.kind, doc.id);
    return doc;
  }
  const title = input.title ?? documentTitle(input.path, input.content);
  const kind = input.kind ?? "doc";
  const { lastInsertRowid } = ctx.db
    .query("INSERT INTO documents (path, title, kind, created_at) VALUES (?, ?, ?, ?)")
    .run(input.path, title, kind, now());
  return { id: Number(lastInsertRowid), path: input.path, title, kind };
}

// Issue へのリンクは Activity に残す。すでにリンクしていれば何もしない
function addLink(ctx: OpCtx, documentId: number, target: ResolvedTarget): void {
  if (target.issue) {
    const { changes } = ctx.db
      .query("INSERT OR IGNORE INTO document_links (document_id, issue_id) VALUES (?, ?)")
      .run(documentId, target.issue.id);
    if (changes > 0) recordEvent(ctx.db, target.issue.id, ctx.actor, "document_attached", { document_id: documentId });
  } else {
    ctx.db.query("INSERT OR IGNORE INTO document_links (document_id, project_id) VALUES (?, ?)").run(documentId, target.projectId ?? null);
  }
}

// リンクを外せたら true。Issue からの解除は Activity に残す
function removeLink(ctx: OpCtx, documentId: number, target: ResolvedTarget): boolean {
  const { changes } = target.issue
    ? ctx.db.query("DELETE FROM document_links WHERE document_id = ? AND issue_id = ?").run(documentId, target.issue.id)
    : ctx.db.query("DELETE FROM document_links WHERE document_id = ? AND project_id = ?").run(documentId, target.projectId ?? null);
  if (changes > 0 && target.issue) recordEvent(ctx.db, target.issue.id, ctx.actor, "document_detached", { document_id: documentId });
  return changes > 0;
}

export function linkDocument(
  ctx: OpCtx,
  target: ResolvedTarget,
  input: { path: string; content: string; title?: string; kind?: DocKind },
): DocumentRef {
  const doc = upsertDocument(ctx, input);
  addLink(ctx, doc.id, target);
  return doc;
}

export function attachDocument(
  ctx: OpCtx,
  target: DocTarget,
  input: { path: string; title?: string; kind?: DocKind; cwd?: string },
): DocumentRef {
  const { abs, content } = readDocumentFile(input.path, input.cwd);
  return tx(ctx.db, () =>
    linkDocument(ctx, resolveDocTarget(ctx.db, target), { path: abs, content, title: input.title, kind: input.kind }),
  );
}

export function detachDocument(ctx: OpCtx, target: DocTarget, path: string, cwd: string = process.cwd()): void {
  const abs = resolve(cwd, path);
  tx(ctx.db, () => {
    const resolved = resolveDocTarget(ctx.db, target);
    const doc = findDocumentByPath(ctx.db, abs);
    if (!doc || !removeLink(ctx, doc.id, resolved)) throw new NodError("NOT_FOUND", `${abs} は添付されていません`);
  });
}

// 登録済みの Document だけを id で読む。ファイルが消えたり読めなかったりしたら content を null にする
export function readDocument(db: Database, id: number): DocumentContent {
  const doc = db.query("SELECT id, path, title, kind FROM documents WHERE id = ?").get(id) as DocumentRef | null;
  if (!doc) throw new NodError("NOT_FOUND", `Document ${id} はありません`);
  let content: string | null;
  try {
    content = readFileSync(doc.path, "utf8");
  } catch {
    content = null;
  }
  return { ...doc, content };
}

// 新しい Document を作る場所。NOD_DB と同じく環境変数で差し替えられる
export function defaultDocsDir(env: Record<string, string | undefined> = process.env): string {
  return env.NOD_DOCS_DIR || join(homedir(), ".local", "share", "nod", "documents");
}

function invalid(message: string): NodError {
  return new NodError("INVALID_ARGS", message);
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// 並行作成で先に作られていた（EEXIST）場合も成功とみなす。実体の検証は呼び出し側の realpath で行う
export function mkdirAllowingExisting(dir: string): void {
  try {
    mkdirSync(dir);
  } catch (e) {
    if ((e as { code?: unknown }).code !== "EEXIST") throw e;
  }
}

// 許可ルートからの相対パスを検証し、ルートの下の絶対パスを返す。
// symlink を辿った実体がルートの外に出るパスは拒否し、足りない親ディレクトリはルートの下にだけ作る
export function prepareDocumentPath(root: string, path: string): string {
  if (path.includes("\0")) throw invalid("作成先に NUL 文字は使えません");
  const rel = path.trim();
  if (!rel || isAbsolute(rel)) throw invalid("作成先は Documents ディレクトリからの相対パスで指定してください");
  const segments = rel.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) throw invalid("作成先に .. は使えません");
  if (!/\.(md|markdown)$/i.test(rel)) throw invalid("作成先は .md か .markdown のファイルにしてください");
  mkdirSync(root, { recursive: true });
  const rootReal = realpathSync(root);
  const abs = resolve(root, ...segments);
  const missing: string[] = [];
  let dir = dirname(abs);
  while (!exists(dir)) {
    missing.unshift(dir);
    dir = dirname(dir);
  }
  const outside = () => invalid("作成先が Documents ディレクトリの外を指しています");
  if (!isInside(rootReal, realpathSync(dir))) throw outside();
  for (const d of missing) mkdirAllowingExisting(d);
  if (!isInside(rootReal, realpathSync(dirname(abs)))) throw outside();
  return abs;
}

export interface CreateDocumentInput extends DocTarget {
  path: string; // Documents ディレクトリからの相対パス
  title?: string; // 省くとファイル名（拡張子なし）
  kind?: DocKind;
  body?: string; // 見出しの後に置く本文
  issueRefs?: string[]; // issueRef に加えてリンクする Issue
  docsDir?: string; // 省くと defaultDocsDir()
}

// 作成と同時に付けるリンク先。Issue（複数可）か Project のどちらか一方
function creationTargets(input: CreateDocumentInput): DocTarget[] {
  const issues = [...new Set([...(input.issueRef ? [input.issueRef] : []), ...(input.issueRefs ?? [])].map((r) => r.trim().toUpperCase()))];
  if (input.projectRef && issues.length) throw invalid("リンク先には Issue か Project のどちらか一方を指定してください");
  return input.projectRef ? [{ projectRef: input.projectRef }] : issues.map((issueRef) => ({ issueRef }));
}

// Markdown ファイルを作って Document として登録する。本文の正本はファイルのまま。
// ファイルは排他作成で上書きせず、DB の登録に失敗したら作ったファイルを消す（ファイルだけ・DB だけを残さない）
export function createDocument(ctx: OpCtx, input: CreateDocumentInput): DocumentRef {
  if (input.kind !== undefined && !(DOC_KINDS as readonly string[]).includes(input.kind)) {
    throw invalid("種類は spec / plan / doc を指定してください");
  }
  // 入力の検証はすべて親ディレクトリを作る前に済ませ、失敗時に空ディレクトリを残さない
  const fileName = input.path.trim().split(/[\\/]+/).at(-1) ?? "";
  const title = input.title?.trim() || basename(fileName, extname(fileName));
  if (/[\r\n]/.test(title)) throw invalid("タイトルに改行は使えません");
  const targets = creationTargets(input);
  for (const t of targets) resolveDocTarget(ctx.db, t); // 対象がなければファイルを作る前に失敗させる
  const abs = prepareDocumentPath(input.docsDir ?? defaultDocsDir(), input.path);
  const body = input.body?.trim() ? `\n${input.body.endsWith("\n") ? input.body : `${input.body}\n`}` : "";
  const content = `# ${title}\n${body}`;
  let created = false;
  try {
    return tx(ctx.db, () => {
      const resolved = targets.map((t) => resolveDocTarget(ctx.db, t));
      writeFileSync(abs, content, { flag: "wx" });
      created = true;
      const doc = upsertDocument(ctx, { path: abs, content, title, kind: input.kind });
      for (const r of resolved) addLink(ctx, doc.id, r);
      return doc;
    });
  } catch (e) {
    if (created) rmSync(abs, { force: true });
    const code = (e as { code?: unknown }).code;
    if (code === "EEXIST") throw new NodError("FILE_EXISTS", `${abs} はすでにあります（上書きしません）`);
    if (code === "ENOTDIR" || code === "EISDIR") throw invalid(`${abs} には作れません`);
    throw e;
  }
}

function findDocumentRef(db: Database, id: number): DocumentRef {
  const doc = db.query("SELECT id, path, title, kind FROM documents WHERE id = ?").get(id) as DocumentRef | null;
  if (!doc) throw new NodError("NOT_FOUND", `Document ${id} はありません`);
  return doc;
}

// Document 側から Issue か Project にリンクする
export function linkDocumentById(ctx: OpCtx, id: number, target: DocTarget): DocumentRef {
  return tx(ctx.db, () => {
    const doc = findDocumentRef(ctx.db, id);
    addLink(ctx, doc.id, resolveDocTarget(ctx.db, target));
    return doc;
  });
}

export function unlinkDocumentById(ctx: OpCtx, id: number, target: DocTarget): void {
  tx(ctx.db, () => {
    const doc = findDocumentRef(ctx.db, id);
    if (!removeLink(ctx, doc.id, resolveDocTarget(ctx.db, target))) {
      throw new NodError("NOT_FOUND", `Document ${id} はリンクされていません`);
    }
  });
}

function linkedIssues(db: Database, id: number): DocumentIssueLink[] {
  const rows = db
    .query(
      `SELECT w.key, i.number, i.title, i.status, i.archived_at FROM document_links l JOIN issues i ON i.id = l.issue_id
       JOIN workspaces w ON w.id = i.workspace_id WHERE l.document_id = ? ORDER BY w.key, i.number`,
    )
    .all(id) as { key: string; number: number; title: string; status: DocumentIssueLink["status"]; archived_at: string | null }[];
  return rows.map((r) => ({ id: `${r.key}-${r.number}`, title: r.title, status: r.status, archived: r.archived_at !== null }));
}

function linkedProjects(db: Database, id: number): DocumentProjectLink[] {
  return db
    .query("SELECT p.id, p.name FROM document_links l JOIN projects p ON p.id = l.project_id WHERE l.document_id = ? ORDER BY p.id")
    .all(id) as DocumentProjectLink[];
}

function createdAtOf(db: Database, id: number): string {
  return (db.query("SELECT created_at FROM documents WHERE id = ?").get(id) as { created_at: string }).created_at;
}

// readDocument に、作成日とリンク先を加えたもの
export function getDocument(db: Database, id: number): DocumentDetail {
  const doc = readDocument(db, id);
  return { ...doc, createdAt: createdAtOf(db, id), issues: linkedIssues(db, id), projects: linkedProjects(db, id) };
}

export function listDocuments(db: Database): DocumentSummary[] {
  const rows = db
    .query("SELECT id, path, title, kind, created_at FROM documents ORDER BY created_at DESC, id DESC")
    .all() as (DocumentRef & { created_at: string })[];
  return rows.map(({ created_at, ...doc }) => ({
    ...doc,
    createdAt: created_at,
    issues: linkedIssues(db, doc.id).map((i) => i.id),
    projects: linkedProjects(db, doc.id),
  }));
}
