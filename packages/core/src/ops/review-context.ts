import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { ReviewPreparation } from "./review-prepare";
import { ReviewFailure } from "./review-failure";
import type { StandardRange } from "./review-scope";
import { sensitiveReviewPath } from "./review-snapshot";

/**
 * 1つの実行専用の読取専用snapshot。code・baseCode・sourceFilesのpathはすべて `path` からの相対パス。
 * 担当エージェントは元の作業ツリーではなくここだけを読む。
 */
export interface ReviewContext {
  path: string;
  /** 固定snapshot（head）の相対パス。実行属性はファイルから読めないので該当パスだけを示す。 */
  code: { paths: string[]; executable: string[] };
  /** 基点本文はdirectory配下の同じ相対パスに全て置く。headと同じblobのファイルは件数だけを示し、異なる・headに無いファイルを列挙する。 */
  baseCode: { directory: string; paths: string[]; sameAsHead: number };
  /** preparation.sourcesと同順の固定本文ファイル。 */
  sourceFiles: { source: string; path: string; hash: string; applicability?: StandardRange[] }[];
  /** 読み込まなかったファイルと理由。途中で止まった場合も、それまでの理由を残す。 */
  excludedSources: { path: string; reason: string }[];
}
/** 固定対象のGit。local対象では独立したsnapshot.gitを読む。blobはbyte列のまま受け取る。 */
export type ReviewContextGit = (...args: string[]) => Promise<{ stdout: string; stdoutBytes: Buffer }>;

/** 書き出す前の空のcontext。materializeReviewContextが途中で止まっても除外理由を保持できるよう、呼出側が先に持つ。 */
export function emptyReviewContext(path: string, runId: string, excludedSources: ReviewContext["excludedSources"] = []): ReviewContext {
  return { path, code: { paths: [], executable: [] }, baseCode: { directory: `.review-base-${runId}`, paths: [], sameAsHead: 0 }, sourceFiles: [], excludedSources };
}

/**
 * 固定commit（またはlocal対象のtree）とmerge-baseのblob、固定資料の本文を、読取専用の通常ファイルとしてcontext.pathへ書き出す。
 * 秘密候補・非通常ファイル・バイナリ・不正なUTF-8・サイズ超過は本文を書かずに除外理由を残し、変更対象が除外されれば止める。
 */
export async function materializeReviewContext(context: ReviewContext, preparation: Pick<ReviewPreparation, "runId" | "sources"> & { target: NonNullable<ReviewPreparation["target"]> }, git: ReviewContextGit): Promise<ReviewContext> {
  const { target, sources } = preparation, cwd = context.path, { code, baseCode } = context;
  mkdirSync(cwd, { recursive: true });
  const blob = async (oid: string): Promise<string | null> => {
    const response = await git("cat-file", "blob", oid);
    // NULがあるblobは従来のbinary区分を維持し、本文を証拠に使わない。
    if (response.stdoutBytes.includes(0)) return "\0";
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(response.stdoutBytes); }
    catch { return null; }
  };
  const entries = (await git("ls-tree", "-rlz", target.local?.treeSha ?? target.headSha)).stdout.split("\0").filter(Boolean);
  const headOids = new Map<string, string>();
  let bytes = 0;
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    const meta = entry.slice(0, tab);
    const path = entry.slice(tab + 1);
    if (!meta || !path) throw new ReviewFailure("SNAPSHOT_FAILED", "固定commitのファイル一覧を解析できません");
    const destination = resolve(cwd, path);
    if (!destination.startsWith(cwd + sep) || path.split("/").some(part => part === ".git" || part === "..")) throw new ReviewFailure("SNAPSHOT_FAILED", "固定snapshot外へのパスは読み込みません");
    const [mode, type, object, size] = meta.trim().split(/\s+/);
    const exclude = (reason: string) => {
      context.excludedSources.push({ path, reason });
      if (target.files.includes(path)) throw new ReviewFailure("SNAPSHOT_EXCLUDED", `変更対象 ${path} は ${reason} のため読み込めません。必要範囲の確認が不足しています`);
    };
    if (mode !== "100644" && mode !== "100755") { exclude("non_regular"); continue; }
    if (sensitiveReviewPath(path)) { exclude("sensitive_path"); continue; }
    if (type !== "blob" || !object || !Number.isFinite(Number(size))) throw new ReviewFailure("SNAPSHOT_FAILED", "固定commitのblobを特定できません");
    if (Number(size) > 2 * 1024 * 1024 || bytes + Number(size) > 64 * 1024 * 1024) { exclude("size_limit"); continue; }
    const content = await blob(object);
    if (content === null) { exclude("invalid_utf8"); continue; }
    if (content.includes("\0")) { exclude("binary"); continue; }
    bytes += Number(size);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, { flag: "wx", mode: 0o444 });
    chmodSync(destination, 0o444);
    code.paths.push(path); headOids.set(path, object);
    if (mode === "100755") code.executable.push(path);
  }
  const baseDirectory = baseCode.directory;
  if (code.paths.some(path => path === baseDirectory || path.startsWith(baseDirectory + "/"))) throw new ReviewFailure("SNAPSHOT_FAILED", "基点資料のパスが固定コードと衝突しました");
  const baseEntries = (await git("ls-tree", "-rlz", target.mergeBaseSha)).stdout.split("\0").filter(Boolean);
  for (const entry of baseEntries) {
    const tab = entry.indexOf("\t"), path = entry.slice(tab + 1);
    const [mode, type, oid, size] = entry.slice(0, tab).trim().split(/\s+/);
    if (path.split("/").some(p => p === ".." || p === ".git")) continue;
    // 変更対象の基点本文を読めない場合は記録する。削除されたファイルは差分以外に読む手段がないため停止する。
    const baseExclude = (reason: string) => {
      if (!target.files.includes(path)) return;
      context.excludedSources.push({ path, reason: `base_${reason}` });
      if (!headOids.has(path)) throw new ReviewFailure("SNAPSHOT_EXCLUDED", `削除された変更対象 ${path} の基点本文は ${reason} のため読み込めません。必要範囲の確認が不足しています`);
    };
    if (!["100644", "100755"].includes(mode!) || type !== "blob") { baseExclude("non_regular"); continue; }
    if (sensitiveReviewPath(path)) { baseExclude("sensitive_path"); continue; }
    if (Number(size) > 2 * 1024 * 1024 || bytes + Number(size) > 128 * 1024 * 1024) { baseExclude("size_limit"); continue; }
    const content = await blob(oid!);
    if (content === null) { baseExclude("invalid_utf8"); continue; }
    if (content.includes("\0")) { baseExclude("binary"); continue; }
    const snapshotPath = `${baseDirectory}/${path}`, destination = resolve(cwd, snapshotPath);
    if (!destination.startsWith(cwd + sep)) throw new ReviewFailure("SNAPSHOT_FAILED", "基点資料のパスがsnapshot外です");
    mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, content, { flag: "wx", mode: 0o444 });
    bytes += Number(size);
    // 同じblobならheadと同内容なので列挙しない。本文はdirectory配下にも置く。
    if (headOids.get(path) === oid) baseCode.sameAsHead++; else baseCode.paths.push(path);
  }
  // 主入力には索引だけを渡す。全文は固定した読取専用ファイルへ保存する。
  const sourceDirectory = `.review-input-${preparation.runId}`;
  if (code.paths.some(path => path === sourceDirectory || path.startsWith(sourceDirectory + "/"))) throw new ReviewFailure("SNAPSHOT_FAILED", "資料用パスが固定コードと衝突しました");
  mkdirSync(join(cwd, sourceDirectory));
  context.sourceFiles = sources.map((s, i) => {
    const path = `${sourceDirectory}/source-${i}.txt`;
    writeFileSync(join(cwd, path), s.content, { flag: "wx", mode: 0o444 });
    return { source: `${s.type}:${s.id}`, path, hash: s.hash, applicability: s.applicability };
  });
  return context;
}
