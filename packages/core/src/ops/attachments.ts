import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { recordEvent } from "../events";
import { findIssueRow, findWritableIssueRow } from "../issue-query";
import type { AttachmentKind, IssueAttachment } from "../types";

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
// 録画（mp4・webm）だけは画面の操作を数分撮ると 10MB を超えるので、上限を別に持つ
export const ATTACHMENT_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
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
  mp4: "video/mp4",
  webm: "video/webm",
};

// 画面に埋め込んで（Content-Disposition: inline で）配信してよい MIME。svg は中でスクリプトが動くので載せない
const INLINE_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/webm"]);

export function isInlineAttachmentMime(mime: string): boolean {
  return INLINE_MIMES.has(mime);
}

export function attachmentMaxBytes(mime: string): number {
  return mime.startsWith("video/") ? ATTACHMENT_VIDEO_MAX_BYTES : ATTACHMENT_MAX_BYTES;
}

function tooLarge(abs: string, max: number): NodError {
  return invalid(`${abs} は大きすぎます（上限 ${max / 1024 / 1024}MB）`);
}

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
  // user:password@ を DB と画面に残さない
  if (url.username || url.password) throw invalid("URL にユーザー名・パスワードは含められません");
  if (url.href.length > ATTACHMENT_URL_MAX) throw invalid(`URL は ${ATTACHMENT_URL_MAX} 文字までです`);
  return url.href;
}

// 制御文字（改行など）と書式文字（U+202E などの双方向制御・ゼロ幅文字）。表示を偽装できるので名前に使わせない
export const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

function normalizeTitle(title: string | undefined): string | null {
  const t = title?.trim();
  if (!t) return null;
  if (/[\r\n]/.test(t)) throw invalid("タイトルに改行は使えません");
  if (CONTROL_OR_FORMAT.test(t)) throw invalid("タイトルに制御文字は使えません");
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
  a: {
    kind: AttachmentKind;
    title: string | null;
    url?: string;
    filePath?: string;
    fileName?: string;
    size?: number;
    mime?: string;
    sourcePath?: string;
  },
): IssueAttachment {
  const { lastInsertRowid } = ctx.db
    .query(
      `INSERT INTO issue_attachments (issue_id, kind, title, url, file_path, file_name, size, mime, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(issueId, a.kind, a.title, a.url ?? null, a.filePath ?? null, a.fileName ?? null, a.size ?? null, a.mime ?? null, ctx.actor, now());
  const row = ctx.db.query("SELECT * FROM issue_attachments WHERE id = ?").get(Number(lastInsertRowid)) as AttachmentRow;
  const attachment = toAttachment(row);
  recordEvent(ctx.db, issueId, ctx.actor, "attachment_added", {
    attachment_id: attachment.id,
    kind: a.kind,
    name: attachmentName(attachment),
    // 監査用に、どこのファイルをコピーしたかを残す（表示は Issue 詳細の Activity だけ）
    ...(a.sourcePath ? { source_path: a.sourcePath } : {}),
  });
  return attachment;
}

export function addLinkAttachment(ctx: OpCtx, ref: string, input: { url: string; title?: string }): IssueAttachment {
  const url = normalizeAttachmentUrl(input.url);
  const title = normalizeTitle(input.title);
  return tx(ctx.db, () => insertAttachment(ctx, findWritableIssueRow(ctx.db, ref).id, { kind: "link", title, url }));
}

// 添付ファイルの名前。制御文字・書式文字を含む名前は拒否し、拡張子で種類を決める
function attachmentFileName(abs: string): { name: string; mime: string } {
  const name = basename(abs);
  if (CONTROL_OR_FORMAT.test(name) || name.includes("\\")) throw invalid("ファイル名に制御文字は使えません");
  const ext = extname(name).slice(1).toLowerCase();
  const mime = Object.hasOwn(ATTACHMENT_TYPES, ext) ? ATTACHMENT_TYPES[ext] : undefined;
  if (!ext || !mime || name.startsWith(".")) {
    throw invalid(`${name} は添付できない種類です（使える拡張子: ${Object.keys(ATTACHMENT_TYPES).join(", ")}）`);
  }
  if (name.length > 255) throw invalid("ファイル名は 255 文字までです");
  return { name, mime };
}

// 元ファイルを symlink を辿らずに開いて読む。開いた後に差し替えられても、読むのは確かめた実体だけになる
function readSourceFile(abs: string, max: number): Buffer {
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
    // O_NONBLOCK: 確かめた後に FIFO へ差し替えられても、書き手を待って止まらない
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "ELOOP") throw invalid(`${abs} はシンボリックリンクです。実体のファイルを指定してください`);
    if (code === "ENOENT") throw new NodError("FILE_NOT_FOUND", `${abs} が見つかりません`);
    throw e;
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) throw invalid(`${abs} は通常のファイルではありません`);
    if (fst.size > max) throw tooLarge(abs, max);
    const data = readFileSync(fd);
    if (data.length > max) throw tooLarge(abs, max);
    return data;
  } finally {
    closeSync(fd);
  }
}

function isInside(root: string, path: string): boolean {
  return path.startsWith(root + sep);
}

function rootReal(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return realpathSync(dir);
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

const OUTSIDE_MESSAGE = "Workspace 内のファイルだけ添付できます";

// 添付してよい元ファイルかを確かめ、実体のパスを返す。認証情報（~/.ssh・~/.aws・.env など）を持ち出させないため、
// 登録済み Workspace か OS の一時ディレクトリの下にあり、そこから先に symlink とドットで始まる名前を経由しないものに限る
export function checkAttachmentSource(db: Database, abs: string, tmpRoot: string = tmpdir()): string {
  // 実体のパスは親ディレクトリの realpath で求める（realpath は FIFO を開いて止まることがあるため、ファイル自体は lstat で確かめる）
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(abs);
  } catch {
    throw new NodError("FILE_NOT_FOUND", `${abs} が見つかりません`);
  }
  if (st.isSymbolicLink()) throw invalid(`${abs} はシンボリックリンクです。実体のファイルを指定してください`);
  if (!st.isFile()) throw invalid(`${abs} は通常のファイルではありません`);
  const parent = realOrNull(dirname(abs));
  if (!parent) throw new NodError("FILE_NOT_FOUND", `${abs} が見つかりません`);
  const real = join(parent, basename(abs));
  const roots = [
    ...(db.query("SELECT path FROM workspaces").all() as { path: string }[]).map((w) => w.path),
    tmpRoot,
  ];
  for (const raw of roots) {
    const rootR = realOrNull(raw);
    if (!rootR) continue;
    const prefix = [resolve(raw), rootR].find((r) => isInside(r, abs));
    if (!prefix) continue;
    const tail = abs.slice(prefix.length + 1);
    // 親ディレクトリも含めて、ルートより下に symlink があれば実体のパスが食い違う
    if (real !== join(rootR, tail)) throw invalid(`${abs} はシンボリックリンクを経由しています。実体のパスを指定してください`);
    if (tail.split(sep).some((part) => part.startsWith("."))) {
      throw invalid(`${abs} は . で始まるファイルかディレクトリの中にあるため添付できません`);
    }
    return real;
  }
  throw invalid(OUTSIDE_MESSAGE);
}

export interface AddFileAttachmentInput {
  path: string; // 添付するファイル。相対パスは cwd から
  title?: string;
  cwd?: string;
  dir?: string; // 省くと defaultAttachmentsDir()
  tmpRoot?: string; // 添付を許す一時ディレクトリ。省くと os.tmpdir()（テストで差し替える）
}

// ファイルを添付ディレクトリの下の <乱数>/<ファイル名> にコピーして登録する。同じ名前でも上書きしない。
// DB の登録に失敗したらコピーを消す（ファイルだけ・DB だけを残さない）
export function addFileAttachment(ctx: OpCtx, ref: string, input: AddFileAttachmentInput): IssueAttachment {
  const abs = resolve(input.cwd ?? process.cwd(), input.path);
  const title = normalizeTitle(input.title);
  const { name, mime } = attachmentFileName(abs);
  findWritableIssueRow(ctx.db, ref); // 対象がなければコピーする前に失敗させる
  const sourcePath = checkAttachmentSource(ctx.db, abs, input.tmpRoot);
  const data = readSourceFile(abs, attachmentMaxBytes(mime));
  const root = rootReal(input.dir ?? defaultAttachmentsDir());
  const rel = `${randomUUID()}/${name}`;
  const dest = join(root, rel);
  let created = false;
  try {
    return tx(ctx.db, () => {
      const issueId = findWritableIssueRow(ctx.db, ref).id;
      mkdirSync(dirname(dest), { mode: 0o700 });
      created = true;
      writeFileSync(dest, data, { flag: "wx", mode: 0o600 });
      return insertAttachment(ctx, issueId, { kind: "file", title, filePath: rel, fileName: name, size: data.length, mime, sourcePath });
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
  // 行を消した後にファイルを消す。削除は commit 済みなので、消せなくても成功として返す。残った実体は gcAttachments が片付ける
  if (!removed.file_path) return;
  try {
    removeStoredFiles([removed.file_path], dir);
  } catch {
    // 権限などで消せなかった実体は gcAttachments に任せる
  }
}

// commit 後に、消した行が指していたコピーを消す。許可ルートの外・symlink は触らない
export function removeStoredFiles(filePaths: string[], dir: string = defaultAttachmentsDir()): void {
  if (filePaths.length === 0) return;
  const root = realOrNull(dir);
  if (!root) return;
  for (const filePath of filePaths) {
    const abs = storedPath(root, filePath);
    if (!abs) continue;
    const parent = dirname(abs);
    rmSync(abs, { force: true });
    if (parent !== root && isInside(root, parent)) rmSync(parent, { recursive: true, force: true });
  }
}

// Workspace の削除などで行ごと消える添付の保存先。削除の tx の中で、消す前に集める
export function workspaceAttachmentPaths(db: Database, workspaceId: number): string[] {
  return (
    db
      .query(
        `SELECT a.file_path FROM issue_attachments a JOIN issues i ON i.id = a.issue_id
         WHERE i.workspace_id = ? AND a.file_path IS NOT NULL`,
      )
      .all(workspaceId) as { file_path: string }[]
  ).map((r) => r.file_path);
}

const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// 追加の途中（ディレクトリを作ってから行を commit するまで）のものを消さないための猶予
export const ATTACHMENT_GC_GRACE_MS = 60_000;

export interface AttachmentGcResult {
  dir: string;
  removed: string[]; // 消した（dryRun なら消す）<uuid> ディレクトリ名
  dryRun: boolean;
}

// DB のどの添付からも参照されない <uuid> ディレクトリを消す。それ以外の名前・symlink・作ってすぐのものは触らない
export function gcAttachments(
  db: Database,
  opts: { dir?: string; dryRun?: boolean; now?: number } = {},
): AttachmentGcResult {
  const dir = opts.dir ?? defaultAttachmentsDir();
  const dryRun = opts.dryRun ?? false;
  const root = realOrNull(dir);
  if (!root) return { dir, removed: [], dryRun };
  const used = new Set(
    (db.query("SELECT file_path FROM issue_attachments WHERE file_path IS NOT NULL").all() as { file_path: string }[]).map(
      (r) => r.file_path.split("/")[0],
    ),
  );
  const at = opts.now ?? Date.now();
  const removed: string[] = [];
  for (const name of readdirSync(root).sort()) {
    if (!UUID_DIR.test(name) || used.has(name)) continue;
    const abs = join(root, name);
    const st = lstatSync(abs);
    if (!st.isDirectory() || at - st.mtimeMs < ATTACHMENT_GC_GRACE_MS) continue;
    if (!dryRun) rmSync(abs, { recursive: true, force: true });
    removed.push(name);
  }
  return { dir, removed, dryRun };
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

// 1 回の Range 応答で返す上限。bytes=0- のように末尾まで求められても、これを越えては読まない（続きはブラウザが求め直す）
export const ATTACHMENT_RANGE_MAX_BYTES = 2 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;

export interface ByteRange {
  start: number;
  end: number; // 末尾を含む（HTTP の Range と同じ）
}

export type AttachmentBody = AttachmentFile & { total: number } & (
    | { range: ByteRange; data: Buffer; stream?: undefined }
    | { range: null; stream: ReadableStream<Uint8Array>; data?: undefined }
  );

// 確かめた後に symlink へ差し替えられても辿らないよう、O_NOFOLLOW で開く
function openAttachmentFd(file: AttachmentFile, id: number): { fd: number; total: number } {
  let fd: number;
  try {
    fd = openSync(file.abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new NodError("FILE_NOT_FOUND", `添付 ${id} のファイルが見つかりません`);
  }
  const st = fstatSync(fd);
  if (!st.isFile()) {
    closeSync(fd);
    throw new NodError("FILE_NOT_FOUND", `添付 ${id} のファイルが見つかりません`);
  }
  return { fd, total: st.size };
}

// 開いたファイルを少しずつ読むストリーム。読み終えるか中断されたら閉じる。チャンクは共有プールでない Buffer に読む
function fdStream(fd: number, total: number): ReadableStream<Uint8Array> {
  let pos = 0;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeSync(fd);
  };
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        try {
          const buf = Buffer.allocUnsafeSlow(Math.min(STREAM_CHUNK_BYTES, total - pos));
          const n = buf.length === 0 ? 0 : readSync(fd, buf, 0, buf.length, pos);
          if (n > 0) controller.enqueue(buf.subarray(0, n));
          pos += n;
          if (n === 0 || pos >= total) {
            close();
            controller.close();
          }
        } catch (e) {
          close();
          controller.error(e);
        }
      },
      cancel: close,
    },
    { highWaterMark: 0 },
  );
}

// ダウンロードの本文。全体をメモリに載せず、ストリームで返す
export function openAttachmentStream(
  db: Database,
  id: number,
  dir: string = defaultAttachmentsDir(),
): AttachmentFile & { total: number; stream: ReadableStream<Uint8Array> } {
  const file = attachmentFile(db, id, dir);
  const { fd, total } = openAttachmentFd(file, id);
  return { ...file, size: total, total, stream: fdStream(fd, total) };
}

// インライン表示の本文。pickRange はファイル全体のサイズから読む範囲を決める（null なら全体をストリームで返す）。
// 範囲は maxBytes までに切り詰めて、その部分だけを読む。end が末尾を越えたら丸め、
// start が末尾以降か end より後なら RANGE_NOT_SATISFIABLE（details.total に全体のサイズ）
export function readAttachmentRange(
  db: Database,
  id: number,
  dir: string = defaultAttachmentsDir(),
  pickRange: (total: number) => ByteRange | null = () => null,
  maxBytes: number = ATTACHMENT_RANGE_MAX_BYTES,
): AttachmentBody {
  const file = attachmentFile(db, id, dir);
  const { fd, total } = openAttachmentFd(file, id);
  let range: ByteRange | null;
  try {
    range = pickRange(total);
    if (range && (range.start >= total || range.start > range.end)) {
      throw new NodError("RANGE_NOT_SATISFIABLE", `添付 ${id} の範囲 ${range.start}-${range.end} は読めません（${total} バイト）`, { total });
    }
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  if (!range) return { ...file, size: total, total, range: null, stream: fdStream(fd, total) };
  try {
    const end = Math.min(range.end, total - 1, range.start + maxBytes - 1);
    const data = Buffer.allocUnsafeSlow(end - range.start + 1);
    let read = 0;
    while (read < data.length) {
      const n = readSync(fd, data, read, data.length - read, range.start + read);
      if (n === 0) break;
      read += n;
    }
    return { ...file, size: read, data: data.subarray(0, read), total, range: { start: range.start, end: range.start + read - 1 } };
  } finally {
    closeSync(fd);
  }
}
