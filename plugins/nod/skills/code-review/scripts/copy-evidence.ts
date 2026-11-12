#!/usr/bin/env bun
// nod:code-review の親が、受け入れ確認の証拠のうち絶対パスの出典（ファイル・ディレクトリ・リンク）を evidence/<n> へ写す（parent.md 8.1）。
// 保存直前の取り直し（parent.md 10節3）も同じスクリプトで行う。
// 写す前に、出典自身・リンクの解決先（途中のリンクを含む）・ディレクトリ配下のすべてのパス（リンクを辿った先を含む）とその解決先を
// 秘密候補の名前（SKILL.md 2節）で検査する。当たれば、どのファイルの本文も読まず、写しも観測も作らない。
// 使い方: bun copy-evidence.ts <出典の絶対パス（~ で始まってよい）> <写し先の evidence/<n> ディレクトリの絶対パス>
// 結果: 標準出力に JSON を1行出す。終了コード 0 = 写した、1 = 取得不能（写しなし。code と message・secrets に理由）、2 = 引数の誤り
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// SKILL.md 2節の秘密候補の名前（parent.md 1節の正規表現と同じ。パスのどこかの要素が当たれば秘密候補）
const SECRET = /(^|\/)(\.env(\.[^/]*)?|\.aws|id_(rsa|ed25519)|credentials(\.[^/]*)?|[^/]*\.(pem|key))(\/|$)/i;
// 辿るリンクの段数の上限（これを超えたら循環とみなす）
const MAX_HOPS = 40;

type Code = "COPIED" | "INVALID_INPUT" | "SECRET_CANDIDATE" | "NOT_FOUND" | "READ_FAILED" | "UNEXPECTED_ERROR";

class Failure extends Error {
  constructor(
    readonly code: Code,
    message: string,
  ) {
    super(message);
  }
}

// 秘密候補に当たったもの。path は出典内のパス（出典から辿った名前）、match は当たったパス（path 自身、途中のリンク先、解決先のどれか）
interface Secret {
  path: string;
  match: string;
}

// 写す対象の1件。path は出典内のパス、real は実際に読む解決先、link はリンクなら readlink の値
interface Entry {
  path: string;
  real: string;
  link: string | null;
  stat: Stats;
}

interface Inspection {
  entries: Entry[];
  secrets: Secret[];
  failures: string[];
  missing: boolean;
}

const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code ?? String(e);
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function emit(result: Record<string, unknown>, exitCode: 0 | 1 | 2): never {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(exitCode);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// 本文を読まずに（lstat・readlink・realpath・stat・readdir だけで）出典の木を調べる
function inspect(source: string): Inspection {
  const out: Inspection = { entries: [], secrets: [], failures: [], missing: false };
  // path: 出典内のパス、at: 実際に lstat するパス（親ディレクトリの解決先 + 名前）、ancestors: 辿っている途中のディレクトリの解決先
  const visit = (path: string, at: string, ancestors: string[]) => {
    if (SECRET.test(path)) {
      out.secrets.push({ path, match: path });
      return;
    }
    let st: Stats;
    try {
      st = lstatSync(at);
    } catch (e) {
      if (path === source && errCode(e) === "ENOENT") out.missing = true;
      else out.failures.push(`${path}（${errCode(e)}）`);
      return;
    }
    let link: string | null = null;
    if (st.isSymbolicLink()) {
      // リンクの途中のパスもすべて検査する（例: notes.txt → a/.env → b/plain.txt）
      let cur = at;
      for (let hop = 0; ; hop++) {
        if (hop === MAX_HOPS) {
          out.failures.push(`${path}（リンクの段数が ${MAX_HOPS} を超えた）`);
          return;
        }
        let target: string;
        let next: Stats;
        try {
          const value = readlinkSync(cur);
          if (hop === 0) link = value;
          target = resolve(realpathSync(dirname(cur)), value);
        } catch (e) {
          out.failures.push(`${path}（リンクを解決できない: ${errCode(e)}）`);
          return;
        }
        if (SECRET.test(target)) {
          out.secrets.push({ path, match: target });
          return;
        }
        try {
          next = lstatSync(target);
        } catch (e) {
          out.failures.push(`${path}（壊れたリンク: ${target} が ${errCode(e)}）`);
          return;
        }
        if (!next.isSymbolicLink()) break;
        cur = target;
      }
    }
    let real: string;
    try {
      real = realpathSync(at);
      st = statSync(real);
    } catch (e) {
      out.failures.push(`${path}（解決できない: ${errCode(e)}）`);
      return;
    }
    if (SECRET.test(real)) {
      out.secrets.push({ path, match: real });
      return;
    }
    if (st.isFile()) {
      out.entries.push({ path, real, link, stat: st });
      return;
    }
    if (!st.isDirectory()) {
      out.failures.push(`${path}（通常ファイルとディレクトリ以外は読まない）`);
      return;
    }
    if (ancestors.includes(real)) {
      out.failures.push(`${path}（リンクの循環: ${real} を辿っている途中）`);
      return;
    }
    out.entries.push({ path, real, link, stat: st });
    let names: string[];
    try {
      names = readdirSync(real);
    } catch (e) {
      out.failures.push(`${path}（ディレクトリを読めない: ${errCode(e)}）`);
      return;
    }
    for (const name of names.sort(byBytes)) visit(join(path, name), join(real, name), [...ancestors, real]);
  };
  visit(source, source, []);
  return out;
}

// 検査を通った木を写す。読むのは検査で確かめた解決先だけで、検査の後にリンクや FIFO へ差し替わっていれば読まずに失敗にする
function copy(source: string, entries: Entry[], target: string): Map<string, string> {
  const digests = new Map<string, string>();
  const dirs: { dest: string; stat: Stats }[] = [];
  for (const entry of entries) {
    const dest = target + entry.path.slice(source.length);
    if (entry.stat.isDirectory()) {
      mkdirSync(dest);
      dirs.push({ dest, stat: entry.stat });
      continue;
    }
    let fd: number;
    try {
      fd = openSync(entry.real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
      throw new Failure("READ_FAILED", `読み取れないため写しません: ${entry.path}（${errCode(e)}）`);
    }
    let data: Buffer;
    try {
      if (!fstatSync(fd).isFile()) throw new Failure("READ_FAILED", `検査の後に通常ファイルでなくなったため写しません: ${entry.path}`);
      data = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    writeFileSync(dest, data, { flag: "wx" });
    chmodSync(dest, entry.stat.mode & 0o7777);
    utimesSync(dest, entry.stat.atime, entry.stat.mtime);
    digests.set(entry.path, createHash("sha256").update(data).digest("hex"));
  }
  // ディレクトリの権限と時刻は中身を書き終えてから戻す（読み取り専用のディレクトリにも書けるように）
  for (const { dest, stat } of dirs.reverse()) {
    chmodSync(dest, stat.mode & 0o7777);
    utimesSync(dest, stat.atime, stat.mtime);
  }
  return digests;
}

// 観測: 出典内のパスの順（LC_ALL=C と同じバイト順）に、リンクならリンク先（readlink の値）、その後に辿った先の種類と各ファイルの sha256
function observe(entries: Entry[], digests: Map<string, string>): string {
  const lines: string[] = [];
  for (const entry of [...entries].sort((a, b) => byBytes(a.path, b.path))) {
    if (entry.link !== null) lines.push(`link\t${entry.path}\t${entry.link}`);
    lines.push(entry.stat.isDirectory() ? `dir\t${entry.path}` : `file\t${entry.path}\t${digests.get(entry.path)}`);
  }
  return lines.map((line) => `${line}\n`).join("");
}

function main(): void {
  const args = process.argv.slice(2);
  const usage = (message: string, source: string | null = null, dest: string | null = null) =>
    emit({ ok: false, code: "INVALID_INPUT", message, source, dest, secrets: [], copy: null, observation: null, observationSha256: null }, 2);
  if (args.length !== 2) usage("使い方: bun copy-evidence.ts <出典の絶対パス> <写し先の evidence/<n> ディレクトリ>");
  const [rawSource, dest] = args as [string, string];
  // 出典の ~ は利用者のホームへ展開する。末尾の / は除く（出典内のパスを出典の後ろにそろえるため）
  const expanded = rawSource === "~" || rawSource.startsWith("~/") ? homedir() + rawSource.slice(1) : rawSource;
  const source = expanded.length > 1 ? expanded.replace(/\/+$/, "") : expanded;
  if (!isAbsolute(source)) usage(`出典は絶対パスで指定してください: ${rawSource}`, rawSource, dest);
  if (!isAbsolute(dest)) usage(`写し先は絶対パスで指定してください: ${dest}`, source, dest);
  const copyPath = join(dest, "copy");
  const observationPath = join(dest, "observation.txt");
  if (exists(copyPath) || exists(observationPath)) usage(`写し先に既に写しか観測があります（上書きしない）: ${dest}`, source, dest);

  const unobtainable = (code: Code, message: string, secrets: Secret[] = []) =>
    emit({ ok: false, code, message, source, dest, secrets, copy: null, observation: null, observationSha256: null }, 1);

  const found = inspect(source);
  if (found.secrets.length) {
    const secrets = found.secrets.sort((a, b) => byBytes(a.path, b.path));
    const list = secrets.map((s) => (s.path === s.match ? s.path : `${s.path}（解決先 ${s.match}）`)).join("、");
    unobtainable("SECRET_CANDIDATE", `秘密情報を含み得るパスに当たるため写しません: ${list}`, secrets);
  }
  if (found.missing) unobtainable("NOT_FOUND", `出典が存在しません: ${source}`);
  if (found.failures.length) unobtainable("READ_FAILED", `読み取れないため写しません: ${found.failures.join("、")}`);

  // 写しの途中で失敗したら、作ったものを消して写しなしにする
  const created = mkdirSync(dest, { recursive: true });
  try {
    const digests = copy(source, found.entries, copyPath);
    const observation = observe(found.entries, digests);
    writeFileSync(observationPath, observation, { flag: "wx" });
    emit(
      {
        ok: true,
        code: "COPIED",
        message: `写しました: ${source}`,
        source,
        dest,
        secrets: [],
        copy: copyPath,
        observation: observationPath,
        observationSha256: createHash("sha256").update(observation).digest("hex"),
      },
      0,
    );
  } catch (e) {
    rmSync(copyPath, { recursive: true, force: true });
    rmSync(observationPath, { force: true });
    if (created) rmSync(created, { recursive: true, force: true });
    if (e instanceof Failure) unobtainable(e.code, e.message);
    unobtainable("UNEXPECTED_ERROR", `写しの途中で失敗したため写しを消しました: ${errCode(e)}: ${(e as Error).message ?? ""}`);
  }
}

main();
