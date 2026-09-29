import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { recordEvent } from "../events";
import { findIssueRow, findWritableIssueRow } from "../issue-query";
import type { AttachmentKind, IssueAttachment } from "../types";

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_URL_MAX = 2048;
export const ATTACHMENT_TITLE_MAX = 200;

// 添付できるファイルの拡張子と、配信するときの Content-Type。ファイルの中身からは推測しない。
// ブラウザで開くと実行されうる html・svg・js などは載せない
export const ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
};

// 添付ファイルのコピーを置く場所。NOD_DB・NOD_DOCS_DIR と同じく環境変数で差し替えられる
export function defaultAttachmentsDir(env: Record<string, string | undefined> = process.env): string {
  return env.NOD_ATTACHMENTS_DIR || join(homedir(), ".local", "share", "nod", "attachments");
}

function invalid(message: string): NodError {
  return new NodError("INVALID_ARGS", message);
}

// http と https だけを受け付け、正規化した URL を返す（javascript: や data: は開かせない）
export function normalizeAttachmentUrl(raw: string): string {
  const text = raw.trim();
  if (!text) throw invalid("URL を指定してください");
  if (text.length > ATTACHMENT_URL_MAX) throw invalid(`URL は ${ATTACHMENT_URL_MAX} 文字までです`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalid(`${text} は URL として読めません（https:// から書いてください）`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw invalid("URL は http:// か https:// のものだけ添付できます");
  if (!url.hostname) throw invalid(`${text} にはホスト名がありません`);
  if (url.href.length > ATTACHMENT_URL_MAX) throw invalid(`URL は ${ATTACHMENT_URL_MAX} 文字までです`);
  return url.href;
}

function normalizeTitle(title: string | undefined): string | null {
  const t = title?.trim();
  if (!t) return null;
  if (/[\r\n]/.test(t)) throw invalid("タイトルに改行は使えません");
  if (t.length > ATTACHMENT_TITLE_MAX) throw invalid(`タイトルは ${ATTACHMENT_TITLE_MAX} 文字までです`);
  return t;
}

interface AttachmentRow {
  id: number;
  issue_id: number;
  kind: AttachmentKind;
  title: string | null;
  url: string | null;
  file_path: string | null;
  file_name: string | null;
  size: number | null;
  mime: string | null;
  created_by: string;
  created_at: string;
}

function toAttachment(r: AttachmentRow): IssueAttachment {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    url: r.url,
    fileName: r.file_name,
    size: r.size,
    mime: r.mime,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

// 表示と Activity に使う名前。タイトルがなければリンクはホスト名、ファイルはファイル名
export function attachmentName(a: Pick<IssueAttachment, "title" | "url" | "fileName">): string {
  if (a.title) return a.title;
  if (a.url) {
    try {
      return new URL(a.url).host;
    } catch {
      return a.url;
    }
  }
  return a.fileName ?? "";
}

// 読むだけなのでアーカイブ済みの Issue も対象にする。issue は内部 ID か API-1 のような ID
export function listIssueAttachments(db: Database, issue: number | string): IssueAttachment[] {
  const id = typeof issue === "number" ? issue : findIssueRow(db, issue).id;
  return (db.query("SELECT * FROM issue_attachments WHERE issue_id = ? ORDER BY id").all(id) as AttachmentRow[]).map(toAttachment);
}

function insertAttachment(
  ctx: OpCtx,
  issueId: number,
  a: { kind: AttachmentKind; title: string | null; url?: string; filePath?: string; fileName?: string; size?: number; mime?: string },
): IssueAttachment {
  const { lastInsertRowid } = ctx.db
    .query(
      `INSERT INTO issue_attachments (issue_id, kind, title, url, file_path, file_name, size, mime, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(issueId, a.kind, a.title, a.url ?? null, a.filePath ?? null, a.fileName ?? null, a.size ?? null, a.mime ?? null, ctx.actor, now());
  const row = ctx.db.query("SELECT * FROM issue_attachments WHERE id = ?").get(Number(lastInsertRowid)) as AttachmentRow;
  const attachment = toAttachment(row);
  recordEvent(ctx.db, issueId, ctx.actor, "attachment_added", { attachment_id: attachment.id, kind: a.kind, name: attachmentName(attachment) });
  return attachment;
}

export function addLinkAttachment(ctx: OpCtx, ref: string, input: { url: string; title?: string }): IssueAttachment {
  const url = normalizeAttachmentUrl(input.url);
  const title = normalizeTitle(input.title);
  return tx(ctx.db, () => insertAttachment(ctx, findWritableIssueRow(ctx.db, ref).id, { kind: "link", title, url }));
}

// 添付ファイルの名前。パスの区切りと制御文字を除き、拡張子で種類を決める
function attachmentFileName(abs: string): { name: string; mime: string } {
  const name = basename(abs).replace(/[\u0000-\u001f\u007f/\\]/g, "_");
  const ext = extname(name).slice(1).toLowerCase();
  const mime = Object.hasOwn(ATTACHMENT_TYPES, ext) ? ATTACHMENT_TYPES[ext] : undefined;
  if (!ext || !mime || name.startsWith(".")) {
    throw invalid(`${name} は添付できない種類です（使える拡張子: ${Object.keys(ATTACHMENT_TYPES).join(", ")}）`);
  }
  if (name.length > 255) throw invalid("ファイル名は 255 文字までです");
  return { name, mime };
}

// 元ファイルを symlink を辿らずに開いて読む。開いた後に差し替えられても、読むのは確かめた実体だけになる
function readSourceFile(abs: string): Buffer {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(abs);
  } catch {
    throw new NodError("FILE_NOT_FOUND", `${abs} が見つかりません`);
  }
  if (st.isSymbolicLink()) throw invalid(`${abs} はシンボリックリンクです。実体のファイルを指定してください`);
  if (!st.isFile()) throw invalid(`${abs} は通常のファイルではありません`);
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "ELOOP") throw invalid(`${abs} はシンボリックリンクです。実体のファイルを指定してください`);
    if (code === "ENOENT") throw new NodError("FILE_NOT_FOUND", `${abs} が見つかりません`);
    throw e;
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) throw invalid(`${abs} は通常のファイルではありません`);
    if (fst.size > ATTACHMENT_MAX_BYTES) throw invalid(`${abs} は大きすぎます（上限 ${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB）`);
    const data = readFileSync(fd);
    if (data.length > ATTACHMENT_MAX_BYTES) throw invalid(`${abs} は大きすぎます（上限 ${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB）`);
    return data;
  } finally {
    closeSync(fd);
  }
}

function isInside(root: string, path: string): boolean {
  return path.startsWith(root + sep);
}

function rootReal(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

export interface AddFileAttachmentInput {
  path: string; // 添付するファイル。相対パスは cwd から
  title?: string;
  cwd?: string;
  dir?: string; // 省くと defaultAttachmentsDir()
}

// ファイルを添付ディレクトリの下の <乱数>/<ファイル名> にコピーして登録する。同じ名前でも上書きしない。
// DB の登録に失敗したらコピーを消す（ファイルだけ・DB だけを残さない）
export function addFileAttachment(ctx: OpCtx, ref: string, input: AddFileAttachmentInput): IssueAttachment {
  const abs = resolve(input.cwd ?? process.cwd(), input.path);
  const title = normalizeTitle(input.title);
  const { name, mime } = attachmentFileName(abs);
  findWritableIssueRow(ctx.db, ref); // 対象がなければコピーする前に失敗させる
  const data = readSourceFile(abs);
  const root = rootReal(input.dir ?? defaultAttachmentsDir());
  const rel = `${randomUUID()}/${name}`;
  const dest = join(root, rel);
  let created = false;
  try {
    return tx(ctx.db, () => {
      const issueId = findWritableIssueRow(ctx.db, ref).id;
      mkdirSync(dirname(dest));
      created = true;
      writeFileSync(dest, data, { flag: "wx" });
      return insertAttachment(ctx, issueId, { kind: "file", title, filePath: rel, fileName: name, size: data.length, mime });
    });
  } catch (e) {
    if (created) rmSync(dirname(dest), { recursive: true, force: true });
    throw e;
  }
}

function findAttachmentRow(db: Database, id: number): AttachmentRow {
  const row = db.query("SELECT * FROM issue_attachments WHERE id = ?").get(id) as AttachmentRow | null;
  if (!row) throw new NodError("NOT_FOUND", `添付 ${id} はありません`);
  return row;
}

// 保存先を許可ルートの下に限って解決する。ルートの外・symlink・通常ファイル以外は null
function storedPath(root: string, filePath: string): string | null {
  const abs = resolve(root, filePath);
  if (!isInside(root, abs)) return null;
  try {
    if (!lstatSync(abs).isFile()) return null;
    if (!isInside(root, realpathSync(abs))) return null;
  } catch {
    return null;
  }
  return abs;
}

export function removeAttachment(ctx: OpCtx, ref: string, id: number, dir: string = defaultAttachmentsDir()): void {
  const removed = tx(ctx.db, () => {
    const issue = findWritableIssueRow(ctx.db, ref);
    const row = ctx.db.query("SELECT * FROM issue_attachments WHERE id = ? AND issue_id = ?").get(id, issue.id) as AttachmentRow | null;
    if (!row) throw new NodError("NOT_FOUND", `添付 ${id} は ${ref.toUpperCase()} にありません`);
    ctx.db.query("DELETE FROM issue_attachments WHERE id = ?").run(id);
    recordEvent(ctx.db, issue.id, ctx.actor, "attachment_removed", {
      attachment_id: id,
      kind: row.kind,
      name: attachmentName(toAttachment(row)),
    });
    return row;
  });
  // 行を消した後にファイルを消す。消せなくても、どこからも参照されないファイルが残るだけにする
  if (removed.file_path) {
    const root = rootReal(dir);
    const abs = storedPath(root, removed.file_path);
    if (abs) {
      const parent = dirname(abs);
      rmSync(abs, { force: true });
      if (parent !== root && isInside(root, parent)) rmSync(parent, { recursive: true, force: true });
    }
  }
}

export interface AttachmentFile {
  abs: string;
  fileName: string;
  mime: string;
  size: number;
}

// ダウンロードするファイル。配信のたびに、実体が許可ルートの下の通常ファイルかを確かめ直す
export function attachmentFile(db: Database, id: number, dir: string = defaultAttachmentsDir()): AttachmentFile {
  const row = findAttachmentRow(db, id);
  if (row.kind !== "file" || !row.file_path || !row.file_name || !row.mime) {
    throw new NodError("NOT_FOUND", `添付 ${id} はファイルではありません`);
  }
  const abs = storedPath(rootReal(dir), row.file_path);
  if (!abs) throw new NodError("FILE_NOT_FOUND", `添付 ${id} のファイルが見つかりません`);
  return { abs, fileName: row.file_name, mime: row.mime, size: lstatSync(abs).size };
}
