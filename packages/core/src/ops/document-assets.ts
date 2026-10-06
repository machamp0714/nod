import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { NodError } from "../errors";
import { ATTACHMENT_MAX_BYTES, CONTROL_OR_FORMAT } from "./attachments";
import { mkdirAllowingExisting } from "./documents";

// Document の隣（images/）に置ける画像。ATTACHMENT_TYPES のうち画面に埋め込んでよい画像だけ（svg は載せない）
export const DOCUMENT_IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const invalid = (message: string) => new NodError("INVALID_ARGS", message);
const notFound = (rel: string) => new NodError("NOT_FOUND", `${rel} はありません`);

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function documentPath(db: Database, id: number): string {
  const row = db.query("SELECT path FROM documents WHERE id = ?").get(id) as { path: string } | null;
  if (!row) throw new NodError("NOT_FOUND", `Document ${id} はありません`);
  return row.path;
}

function imageMime(name: string): string | undefined {
  const ext = extname(name).slice(1).toLowerCase();
  return Object.hasOwn(DOCUMENT_IMAGE_TYPES, ext) ? DOCUMENT_IMAGE_TYPES[ext] : undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");

// 貼り付けた画像の名前。時刻はサーバーのローカル時刻
function pastedName(ext: string, at: Date): string {
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const rand = Array.from(randomBytes(4), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  return `${stamp}-${rand}.${ext}`;
}

// ドロップした画像の名前。空白は - にし、制御文字・区切り・先頭の . は拒否する
function droppedName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, "-");
  if (CONTROL_OR_FORMAT.test(normalized) || /[\\/]/.test(normalized) || normalized.startsWith(".")) throw invalid(`${name} は画像の名前に使えません`);
  if (normalized.length > 255) throw invalid("ファイル名は 255 文字までです");
  return normalized;
}

// 画像を .md と同じディレクトリの images/ に保存し、.md からの相対パスを返す。同名があれば -2, -3 と番号を付ける
export function saveDocumentAsset(
  db: Database,
  id: number,
  input: { name: string; data: Uint8Array; pasted: boolean; now?: Date },
): { path: string } {
  const mime = imageMime(input.name);
  if (!mime) throw invalid(`${input.name} は貼れない種類です（使える拡張子: ${Object.keys(DOCUMENT_IMAGE_TYPES).join(", ")}）`);
  if (input.data.byteLength > ATTACHMENT_MAX_BYTES) throw invalid(`画像が大きすぎます（上限 ${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB）`);
  const ext = extname(input.name).slice(1).toLowerCase();
  const base = input.pasted ? pastedName(ext, input.now ?? new Date()) : droppedName(input.name);
  const docDir = dirname(documentPath(db, id));
  if (!existsSync(docDir)) throw new NodError("FILE_NOT_FOUND", `${docDir} が見つかりません`);
  const rootReal = realpathSync(docDir);
  const imagesDir = join(docDir, "images");
  mkdirAllowingExisting(imagesDir);
  let imagesReal: string;
  try {
    imagesReal = realpathSync(imagesDir);
    if (!statSync(imagesDir).isDirectory()) throw invalid("images がディレクトリではありません");
  } catch (e) {
    if (e instanceof NodError) throw e;
    throw invalid("images がディレクトリではありません（リンク切れの可能性があります）");
  }
  if (!isInside(rootReal, imagesReal)) throw invalid("images が Document のディレクトリの外を指しています");
  const stem = basename(base, extname(base));
  const suffix = extname(base);
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${stem}-${n}${suffix}`;
    try {
      writeFileSync(join(imagesDir, name), input.data, { flag: "wx" });
      return { path: `images/${name}` };
    } catch (e) {
      if ((e as { code?: unknown }).code !== "EEXIST") throw e;
    }
  }
}

// .md のディレクトリからの相対パスを、その下の画像の実体に解決する。外に出るもの・画像でないものはすべて NOT_FOUND
export function resolveDocumentAsset(db: Database, id: number, rel: string): { abs: string; mime: string; fileName: string } {
  const docDir = dirname(documentPath(db, id));
  if (!rel || rel.includes("\0") || isAbsolute(rel)) throw notFound(rel);
  const segments = rel.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.includes("..")) throw notFound(rel);
  const abs = resolve(docDir, ...segments);
  const mime = imageMime(abs);
  if (!mime) throw notFound(rel);
  let real: string;
  try {
    real = realpathSync(abs);
    // symlink の行き先も画像でなければ返さない（images/x.png -> ../.env を防ぐ）
    if (!imageMime(real) || !isInside(realpathSync(docDir), real) || !lstatSync(real).isFile()) throw notFound(rel);
  } catch (e) {
    if (e instanceof NodError) throw e;
    throw notFound(rel);
  }
  return { abs: real, mime, fileName: basename(abs) };
}
