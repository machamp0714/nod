#!/usr/bin/env bun
// nod:code-review の親が、受け入れ確認の証拠のうち明示的に参照された絶対パスの通常のファイル1つを evidence/<n> へ写す（parent.md 8.1）。
// 保存直前の取り直し（parent.md 10節3）も同じスクリプトで、同じ検査をして行う。
// 写すのは通常のファイルだけで、リンクは辿らない。次のものは本文を読まずに取得不能にし、写しも観測も作らない:
// 秘密候補の名前（SKILL.md 2節）を含むパス、. や .. や空の要素を含むパス、過去と現在のレビューの作業ディレクトリ（親専用領域を含む）と
// 常設データセットの配下、どこかの要素がシンボリックリンクのパス、ディレクトリ、通常のファイル以外（FIFO・デバイス・ソケット）、上限サイズを超えるもの。
// 使い方: bun copy-evidence.ts <出典の絶対パス（~ で始まってよい）> <写し先の evidence/<n> ディレクトリの絶対パス>
// 結果: 標準出力に JSON を1行出す。終了コード 0 = 写した、1 = 取得不能（写しなし。code と message・secrets に理由）、2 = 引数の誤り
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// SKILL.md 2節の秘密候補の名前（parent.md 1節の正規表現と同じ。パスのどこかの要素が当たれば秘密候補）
const SECRET = /(^|\/)(\.env(\.[^/]*)?|\.aws|id_(rsa|ed25519)|credentials(\.[^/]*)?|[^/]*\.(pem|key))(\/|$)/i;
// 写せる上限のバイト数（parent.md 8.1 の URL の行の --max-filesize と同じ）
const MAX_BYTES = 20_000_000;
// ホームからの相対で、配下を写さない領域: レビューの作業ディレクトリ（過去の実行と、現在の実行の <W> とその親専用領域 <W>/parent/）と常設データセット
const FORBIDDEN_AREAS = [".local/share/nod/code-reviews", ".local/share/nod/review-evaluation"];

type Code =
  | "COPIED"
  | "INVALID_INPUT"
  | "SECRET_CANDIDATE"
  | "NON_CANONICAL_PATH"
  | "FORBIDDEN_AREA"
  | "SYMLINK_IN_PATH"
  | "NOT_REGULAR_FILE"
  | "TOO_LARGE"
  | "NOT_FOUND"
  | "READ_FAILED"
  | "UNEXPECTED_ERROR";

// 秘密候補に当たったもの。path は出典、match は当たったパス（出典自身）
interface Secret {
  path: string;
  match: string;
}

const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code ?? String(e);
// 大文字小文字・Unicode の正規化を区別しないファイルシステム（macOS）でも同じ場所を同じ名前として比べる
const foldName = (path: string) => path.normalize("NFC").toLowerCase();

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

// 禁止領域の根。ホームがリンクを含む環境でも、実体のパスで書かれた出典を逃さないよう、ホームの実体からの根も加える
function forbiddenRoots(): string[] {
  const homes = [homedir()];
  try {
    homes.push(realpathSync(homedir()));
  } catch {
    // ホームが無ければ、書かれたホームの根だけで比べる
  }
  return homes.flatMap((home) => FORBIDDEN_AREAS.map((area) => foldName(join(home, area))));
}

function main(): void {
  const args = process.argv.slice(2);
  const usage = (message: string, source: string | null = null, dest: string | null = null) =>
    emit({ ok: false, code: "INVALID_INPUT", message, source, dest, secrets: [], copy: null, observation: null, observationSha256: null }, 2);
  if (args.length !== 2) usage("使い方: bun copy-evidence.ts <出典の絶対パス> <写し先の evidence/<n> ディレクトリ>");
  const [rawSource, dest] = args as [string, string];
  // 出典の ~ は利用者のホームへ展開する。ほかの書き換え（末尾の / の除去や正規化）はしない
  const source = rawSource === "~" || rawSource.startsWith("~/") ? homedir() + rawSource.slice(1) : rawSource;
  if (!isAbsolute(source)) usage(`出典は絶対パスで指定してください: ${rawSource}`, rawSource, dest);
  if (!isAbsolute(dest)) usage(`写し先は絶対パスで指定してください: ${dest}`, source, dest);
  const copyPath = join(dest, "copy");
  const observationPath = join(dest, "observation.txt");
  if (exists(copyPath) || exists(observationPath)) usage(`写し先に既に写しか観測があります（上書きしない）: ${dest}`, source, dest);

  // 型を明示して、呼んだ後を到達しない扱いにする（変数の代入の判定に使う）
  const unobtainable: (code: Code, message: string, secrets?: Secret[]) => never = (code, message, secrets = []) =>
    emit({ ok: false, code, message, source, dest, secrets, copy: null, observation: null, observationSha256: null }, 1);

  // 名前だけの検査（何も開かない）
  if (SECRET.test(source)) {
    unobtainable("SECRET_CANDIDATE", `秘密情報を含み得るパスに当たるため写しません: ${source}`, [{ path: source, match: source }]);
  }
  const names = source === "/" ? [] : source.slice(1).split("/");
  if (names.some((name) => name === "" || name === "." || name === "..")) {
    unobtainable("NON_CANONICAL_PATH", `. や .. や空の要素（// や末尾の /）を含むパスは、書かれたパスと読むパスがずれ得るため写しません: ${source}`);
  }
  const folded = foldName(source);
  const area = forbiddenRoots().find((root) => folded === root || folded.startsWith(`${root}/`));
  if (area !== undefined) {
    unobtainable("FORBIDDEN_AREA", `レビューの作業ディレクトリ・親専用領域・常設データセットの配下は写しません: ${source}`);
  }

  // lstat だけの検査: ルートから出典までの各要素を lstat し、リンクを辿らない
  const prefixes = names.map((_, i) => `/${names.slice(0, i + 1).join("/")}`);
  const inspected: Stats[] = [];
  let stat = lstatSync("/");
  for (const prefix of prefixes) {
    try {
      stat = lstatSync(prefix);
    } catch (e) {
      const code = errCode(e);
      if (code === "ENOENT" || code === "ENOTDIR") unobtainable("NOT_FOUND", `出典が存在しません: ${source}（${prefix} が ${code}）`);
      unobtainable("READ_FAILED", `読み取れないため写しません: ${source}（${prefix} が ${code}）`);
    }
    if (stat.isSymbolicLink()) unobtainable("SYMLINK_IN_PATH", `パスにシンボリックリンクを含むため、辿らずに写しません: ${prefix}`);
    inspected.push(stat);
  }
  if (stat.isDirectory()) unobtainable("NOT_REGULAR_FILE", `ディレクトリは写しません（通常のファイルだけを写す）: ${source}`);
  if (!stat.isFile()) unobtainable("NOT_REGULAR_FILE", `通常のファイルでない（FIFO・デバイス・ソケットなど）ため読まずに写しません: ${source}`);
  if (stat.size > MAX_BYTES) unobtainable("TOO_LARGE", `上限 ${MAX_BYTES} バイトを超える（${stat.size} バイト）ため読まずに写しません: ${source}`);

  // 読み取り: 最後の要素のリンクを開かず（O_NOFOLLOW）、FIFO で止まらず（O_NONBLOCK）、検査したものと同じファイルであることを確かめてから読む
  let fd: number;
  try {
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = errCode(e);
    if (code === "ELOOP") unobtainable("SYMLINK_IN_PATH", `検査の後にシンボリックリンクへ変わったため写しません: ${source}`);
    if (code === "ENOENT") unobtainable("NOT_FOUND", `検査の後に出典が無くなりました: ${source}`);
    unobtainable("READ_FAILED", `読み取れないため写しません: ${source}（${code}）`);
  }
  let data: Buffer;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      unobtainable("READ_FAILED", `検査の後に別のファイルへ変わったため写しません: ${source}`);
    }
    if (opened.size > MAX_BYTES) unobtainable("TOO_LARGE", `上限 ${MAX_BYTES} バイトを超える（${opened.size} バイト）ため写しません: ${source}`);
    // 開いた時点の大きさより1バイト多く読めたら、読む間に変わったものとして写さない
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    for (let n = -1; n !== 0 && length < buffer.length; length += n) n = readSync(fd, buffer, length, buffer.length - length, null);
    if (length > opened.size) unobtainable("READ_FAILED", `読む間に大きさが変わったため写しません: ${source}`);
    data = buffer.subarray(0, length);
  } catch (e) {
    unobtainable("READ_FAILED", `読み取れないため写しません: ${source}（${errCode(e)}）`);
  } finally {
    closeSync(fd);
  }

  // 読んだ後に各要素を lstat し直し、リンクに変わった・別のものに置き換わったなら写さない
  for (const [i, prefix] of prefixes.entries()) {
    let now: Stats;
    try {
      now = lstatSync(prefix);
    } catch (e) {
      unobtainable("READ_FAILED", `読む間に出典のパスが変わったため写しません: ${prefix}（${errCode(e)}）`);
    }
    if (now.isSymbolicLink()) unobtainable("SYMLINK_IN_PATH", `読む間にシンボリックリンクへ変わったため写しません: ${prefix}`);
    const before = inspected[i] as Stats;
    if (now.dev !== before.dev || now.ino !== before.ino) unobtainable("READ_FAILED", `読む間に別のものへ置き換わったため写しません: ${prefix}`);
  }

  // 写しの途中で失敗したら、作ったものを消して写しなしにする
  const observation = `file\t${source}\t${data.length}\t${createHash("sha256").update(data).digest("hex")}\n`;
  const created = mkdirSync(dest, { recursive: true });
  try {
    writeFileSync(copyPath, data, { flag: "wx" });
    writeFileSync(observationPath, observation, { flag: "wx" });
  } catch (e) {
    rmSync(copyPath, { force: true });
    rmSync(observationPath, { force: true });
    if (created) rmSync(created, { recursive: true, force: true });
    unobtainable("UNEXPECTED_ERROR", `写しの途中で失敗したため写しを消しました: ${errCode(e)}: ${(e as Error).message ?? ""}`);
  }
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
}

main();
