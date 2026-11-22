// 利用者の OMP の設定（<PI_CODING_AGENT_DIR>/config.yml）の読み書き。適用は読み込みの設定を書かない。書くのは、以前の配置
// （config.yml に読み込みの設定を入れた適用）の項目を取り除くときだけ（harness.ts）。
// - 読み書きは Bun の YAML。書くときは OMP と同じ形（Bun.YAML.stringify の2字字下げで、マッピングの見出しの行末の空白を除く）にする。
//   YAML として書き直すとコメントは残らないので、以前の配置の記録があり、その適用の後に config.yml が変わっていなければ、適用の前のバイトに戻す。
// - config.yml がシンボリックリンクなら、OMP と同じくリンクの先に書く。書くときは同じディレクトリの一時ファイルに書いてから rename する。
// - OMP は config.yml を書くとき、`<config.yml の実体>.lock` に flock(2) の排他ロックを取る（macOS。Linux では別の仕組み）。
//   macOS では同じロックを取ってから読み、書き終えるまで持つ。実行中の OMP が設定を保存するときに、こちらの変更を上書きしないため。
import { dlopen, FFIType } from "bun:ffi";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PstackOmpError } from "./context";

export interface OmpConfig {
  // config.yml のパス（リンクなら先）
  path: string;
  // いまのバイト。無ければ undefined
  bytes: Buffer | undefined;
  // 読んだ値（無い、空なら {}）
  data: Record<string, unknown>;
}

// config.yml のパス。リンクを解き、置き場がまだ無くても、在る祖先の別名（macOS の /var と /private/var など）を解いた形にする
// （適用の記録と解除で同じパスになるように）
export function configPath(agentDir: string): string {
  return realAncestor(join(agentDir, "config.yml"));
}

// path のリンクと別名を解いた形。path がまだ無ければ、在る祖先まで解いて残りをつなぐ
export function realAncestor(path: string): string {
  for (let at = path, rest = ""; ; ) {
    try {
      return join(realpathSync(at), rest);
    } catch {
      if (dirname(at) === at) return path;
      rest = join(basename(at), rest);
      at = dirname(at);
    }
  }
}

// 読めなければ（YAML として不正、全体がマッピングでない）止める
export function readConfig(path: string): OmpConfig {
  const bytes = existsSync(path) ? readFileSync(path) : undefined;
  return { path, bytes, data: bytes === undefined ? {} : parseConfig(path, bytes) };
}

// config.yml のバイトの値（空なら {}）。読めなければ（YAML として不正、全体がマッピングでない）止める
export function parseConfig(path: string, bytes: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(bytes.toString("utf8"));
  } catch (e) {
    throw new PstackOmpError(`OMP の設定 ${path} を YAML として読めません: ${(e as Error).message}。直してから、もう一度実行してください`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PstackOmpError(`OMP の設定 ${path} の全体がマッピングではありません。直してから、もう一度実行してください`);
  }
  return parsed as Record<string, unknown>;
}

export function stringifyConfig(data: Record<string, unknown>): string {
  return Bun.YAML.stringify(data, null, 2).replace(/: +$/gm, ":");
}

// 設定の値（skills.customDirectories のような . 区切りの id）。途中がマッピングでなければ undefined
export function valueAt(data: Record<string, unknown>, id: string): unknown {
  let value: unknown = data;
  for (const key of id.split(".")) {
    value = isMapping(value) ? value[key] : undefined;
  }
  return value;
}

export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 設定の値のうち文字列の配列のもの。文字列の配列でなければ止める。無ければ undefined
export function stringList(config: Pick<OmpConfig, "path" | "data">, id: string): string[] | undefined {
  const value = valueAt(config.data, id);
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
    throw new PstackOmpError(`OMP の設定 ${config.path} の ${id} が文字列の配列ではありません。直してから、もう一度実行してください`);
  }
  return value;
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// 書き換えの準備（一時ファイルまで書く）。commit で置き換え、discard で一時ファイルを消す。
// bytes が undefined なら commit で config.yml を消す
export interface PreparedWrite {
  commit(): void;
  discard(): void;
}

export function prepareWrite(path: string, bytes: Buffer | string | undefined): PreparedWrite {
  if (bytes === undefined) return { commit: () => rmSync(path, { force: true }), discard: () => {} };
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.config.yml.pstack-omp-${randomBytes(6).toString("hex")}`);
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  writeFileSync(temp, bytes, { mode });
  return { commit: () => renameSync(temp, path), discard: () => rmSync(temp, { force: true }) };
}

const LOCK_EX = 2;
const LOCK_NB = 4;
// OMP と同じ待ち方（100ms ごとに 50 回）
const LOCK_RETRIES = 50;
const LOCK_DELAY_MS = 100;

// config.yml の書き込みのロックを持って fn を実行する（macOS だけ。ほかでは持たずに実行する）。config.yml が無ければ持たずに実行する
// （適用と解除は無い config.yml を書かないので、利用者の OMP の設定の置き場にロックのファイルを作らない）
export function withConfigLock<T>(path: string, fn: () => T): T {
  if (process.platform !== "darwin" || !existsSync(path)) return fn();
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_RDONLY | constants.O_CREAT, 0o600);
  } catch (e) {
    throw new PstackOmpError(`OMP の設定のロック ${lockPath} を開けません: ${(e as Error).message}`);
  }
  try {
    const flock = dlopen("libc.dylib", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock;
    for (let attempt = 1; flock(fd, LOCK_EX | LOCK_NB) !== 0; attempt++) {
      if (attempt >= LOCK_RETRIES) {
        throw new PstackOmpError(`OMP の設定のロック ${lockPath} を ${(LOCK_RETRIES * LOCK_DELAY_MS) / 1000} 秒待っても取れません（OMP が設定を書いている）。少し待ってから、もう一度実行してください`);
      }
      Bun.sleepSync(LOCK_DELAY_MS);
    }
    return fn();
  } finally {
    // 閉じるとロックも外れる
    closeSync(fd);
  }
}
