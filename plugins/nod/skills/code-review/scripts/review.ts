#!/usr/bin/env bun
// nod:code-review の親の定型作業を、段階の境目ごとのサブコマンドで行う（parent.md）。モデルを起動せず、テスト・Lint・ビルドを実行しない。
// 使い方: bun review.ts <subcommand> --work <作業ディレクトリ W の絶対パス> ...
//   prepare（parent.md 1〜2節）: 対象の固定、秘密候補・空差分の検査、担当用の限定 clone と確認、依存の写しと指紋、共通入力と目録、head を固定した元。
//     --repo <絶対パス> --base <基点の指定> (--mode commit --head <SHA か ref> [--pr <URL>] | --mode local [--untracked <相対パス>]...)
//     [--issue <ID> | --request <絶対パス>... | --request-doc <Document ID>...] [--work <W（存在しないか空）> | --work-root <絶対パス>]
//     評価用の事例: --case <常設データセットの inputs/<case-id> の絶対パス> [--repo <絶対パス>]（nod を使わず case.md と requirements/ から作る）
//     W の既定は $HOME/.local/share/nod/code-reviews/<小文字の uuid>。後の段階は checkIdentity（段階名を受ける）で同一性を確かめ直す
//   agent（parent.md 4節）: --work <W> --role standards|spec|refute|acceptance --event start|received [--agent-id <担当 ID>]
//     委譲の開始（委譲の直前）と最終返答の受領の時刻・試行の番号・担当 ID を parent/agents.md（と agents.json）に記録する
//   check-explore（5節）: --work <W> --role standards|spec。引き渡し用ファイルの形式と参照、同一性を機械的に検査し、parent/checks.md（と checks.json）に書く
//   retire-attempt（4.1節）: --work <W> --role <役割> --failure invalid|usage-limit|aborted --reason <無効の理由> [--retries <omp 内部の再試行>]
//     最新の試行を parent/attempts/<役割>-<n>/ へ隔離し、同じ入力を確かめて parent/attempts.md（と attempts.json）に書き、委譲し直せるかを返す
//   refute-input（6節）: --work <W>。合格した両探索の引き渡しと共通入力を refute-input/ へ写し、検査時の指紋と照合して parent/fingerprints.md に書く
//   check-refute（7節・8節）: --work <W>。反証の判定本文の形式・参照・集計の一致と同一性を機械的に検査して parent/checks.md に書き、
//     合格なら読み取った構造を parent/refute-structure.json に、受け入れ確認担当の行を parent/acceptance/rows.md に書く
//   acceptance-records（8.1節）: --work <W>。受け入れ確認担当の行があるときだけ、共通入力・反証の判定本文・Activity・全添付 Document を
//     acceptance-input/ へ写し（CI の結果を印で除き、元の写しは parent/acceptance/）、写す参照の候補を parent/acceptance/ref-candidates.{json,md} に挙げる
//   acceptance-input（8.1節）: --work <W> --refs <親が決めた参照の一覧の JSON>（評価用の事例では省く）。証拠を許可された方法で evidence/ へ写し、
//     目録 acceptance-input/records.md と親専用の記録（parent/acceptance/items.json・evidence.json・fingerprints.md）を作って指紋を照合する
//   check-acceptance（9節）: --work <W>。受け入れ確認の結果の形式・担当全行・5つの部分・不足理由・使った証拠・矛盾の表と同一性を機械的に検査して
//     parent/checks.md に書き、合格なら読み取った構造を parent/acceptance-structure.json に書く
//   finalize（10節・11節・14節）: --work <W> [--own-log <記録の id>]... [--not-run-reason <担当を1つも起動しなかった理由>]
//     [--session <親のセッション記録の絶対パス>（無ければ PI_SESSION_FILE）] [--skill-start <スキルの読み込みの開始の ISO 時刻>]
//     [--auto-check-rows pass|block（評価用の事例では必須、通常のレビューでは使わない）]。保存直前の再照合
//     （parent/local-recheck/・requirements-recheck/・acceptance-recheck/）、最終状態・点数・確認が残る事項、CI の照合（parent/ci/1/、ci-checks.ts）と
//     現在の head の照合（parent/head-check.md）、マージ可否（評価用の事例では別に CI を除いたレビュー側の判定）、監査 parent/audit.md と結果 parent/report.md の
//     組み立てと保存（Issue があれば監査→結果の順に kind=doc の Document へ保存して照合）、作業ログ・own-logs.md・merge-ready、区間の時間と使用量
//     （parent/usage.json・usage.md）を行う。評価用の事例では nod へ保存せずラベルも扱わない
//   recheck-ci（13節）: --work <W> [--own-log <記録の id>]...。同じ head の CI とマージ可否を parent/recheck-<n>/・parent/ci/<n>/ へ照合し直し、merge-ready を付け外しする
//   usage（14節）: --session <親のセッション記録の絶対パス> --from <ISO 時刻> --to <ISO 時刻> --out <記録先の絶対パス> [--agent <担当 ID>]... [--agent-file <絶対パス>]...
//     作業ディレクトリなしで、任意のセッション記録の時刻の範囲（開始を含み終了を含まない）の使用量を集計し、<out>/usage.json・usage.md に書く（MIN-33 の前回の比較など）
// 外部コマンドとして curl（https の URL の GET）と、同じディレクトリの copy-evidence.ts（通常のファイル）・ci-checks.ts（同じ head の CI）も起動する。
// 結果: 標準出力に JSON を1行出し、同じものを <W>/parent/<subcommand>.json（usage は <out>/usage.json）に書く。作業ディレクトリのある呼び出しは、
// 終了コード 0 で終えたときに開始と終了の時刻を parent/stages.json（と stages.md）に足す（区間の計測に使う）
// 終了コード 0 = 実行して結果を書いた（未実施などの否定の結果でも 0）、2 = 引数の誤り（code INVALID_INPUT。判定ではない）、それ以外 = 予期しない失敗
// 外部コマンド: nod は NOD_CLI（無ければ nod）、gh は NOD_GH（無ければ gh。PR の現在の head と基点）、git・tar とパッケージ管理（bun・npm・pnpm・yarn・node）は PATH から起動する。
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

type Json = Record<string, unknown>;

// 引数の誤り。終了コード 2 で返し、判定とは扱わない
class UsageError extends Error {}

interface Outcome {
  // 作業ディレクトリ W。W の無い呼び出し（任意のセッション記録を集計する usage）は null
  work: string | null;
  // 結果の JSON を書く場所（既定は <W>/parent/<subcommand>.json）
  record?: string;
  result: Json;
}

// パスのどこかの要素が秘密情報を含み得る名前に当たる（SKILL.md 2節、parent.md 1節。copy-evidence.ts と同じ規則）
const SECRET = /(^|\/)(\.env(\.[^/]*)?|\.aws|id_(rsa|ed25519)|credentials(\.[^/]*)?|[^/]*\.(pem|key))(\/|$)/i;
const SHA = /^[0-9a-f]{40}$/i;
const NOT_RUN_SCORE = "点数なし";
const NOT_RUN_MERGE = "不可（人の判断が要る）";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const now = () => new Date().toISOString();

// ---- 外部コマンド ----

interface Proc {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  error: string | null;
}

function exec(cmd: string[], opts: { cwd?: string; input?: string | Buffer } = {}): Proc {
  const [file, ...args] = cmd;
  const p = spawnSync(file ?? "", args, { cwd: opts.cwd, input: opts.input, maxBuffer: 1 << 30 });
  return { code: p.status, stdout: p.stdout ?? Buffer.alloc(0), stderr: p.stderr?.toString() ?? "", error: p.error ? String(p.error.message) : null };
}

function git(repo: string, ...args: string[]): Proc {
  return exec(["git", "-C", repo, ...args]);
}

// 成功を前提にする git の読み取り。失敗は予期しない失敗として扱う
function gitText(repo: string, ...args: string[]): string {
  const p = git(repo, ...args);
  if (p.code !== 0) throw new Error(`git ${args.join(" ")} が失敗しました: ${p.stderr || p.error}`);
  return p.stdout.toString().trim();
}

function nod(args: string[], input?: string): Proc {
  return exec([process.env.NOD_CLI || "nod", ...args], { input });
}

// 失敗の理由。nod の --json は失敗を標準出力の {"error": {"code", "message"}} で返すので、あればそれを、無ければ標準エラーの末尾を書く
function failure(p: Proc): string {
  const e = p.code !== 0 ? (parseJson(p) as { error?: { code?: unknown; message?: unknown } } | undefined)?.error : undefined;
  const text = typeof e?.message === "string" ? `${typeof e.code === "string" ? `${e.code}: ` : ""}${e.message}` : (p.error ?? p.stderr).trim().split("\n").slice(-3).join(" ");
  return `終了コード ${p.code ?? "なし"}: ${text || "出力なし"}`;
}

// ---- 引数 ----

interface Options {
  one: Map<string, string>;
  // 繰り返し可の引数を、指定された順に
  many: { key: string; value: string }[];
}

function parseOptions(args: string[], single: readonly string[], multi: readonly string[]): Options {
  const one = new Map<string, string>();
  const many: { key: string; value: string }[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.startsWith("--") ? args[i]?.slice(2) ?? "" : "";
    const value = args[i + 1];
    if (!single.includes(key) && !multi.includes(key)) throw new UsageError(`知らない引数です: ${args[i]}`);
    if (value === undefined) throw new UsageError(`--${key} の値がありません`);
    if (multi.includes(key)) many.push({ key, value });
    else if (one.has(key)) throw new UsageError(`--${key} が重なっています`);
    else one.set(key, value);
  }
  return { one, many };
}

function absolute(name: string, value: string | undefined): string | undefined {
  if (value !== undefined && !isAbsolute(value)) throw new UsageError(`--${name} は絶対パスで指定してください: ${value}`);
  return value;
}

// ---- 指紋 ----

interface Entry {
  rel: string;
  path: string;
  kind: "file" | "link";
}

// dir の配下の通常のファイルとリンク（リンクは辿らない）を、find . の表記（./<相対パス>）のバイト順で
function walkEntries(dir: string): Entry[] {
  const out: Entry[] = [];
  const walk = (path: string, rel: string) => {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) out.push({ rel, path, kind: "link" });
    else if (st.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name), `${rel}/${name}`);
    else if (st.isFile()) out.push({ rel, path, kind: "file" });
  };
  if (existsSync(dir)) walk(dir, ".");
  return out.sort((a, b) => Buffer.compare(Buffer.from(a.rel), Buffer.from(b.rel)));
}

export interface FileHash {
  path: string;
  sha256: string;
}

// dir の配下の通常のファイル（リンクは数えない）の相対パスと sha256 を、find . の表記のバイト順で
export function fingerprintList(dir: string, exclude?: string): FileHash[] {
  return walkEntries(dir)
    .filter((e) => e.kind === "file" && e.rel !== `./${exclude}`)
    .map((e) => ({ path: e.rel.slice(2), sha256: sha256(readFileSync(e.path)) }));
}

// parent.md の `find . -type f [! -path ./<exclude>] -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256` と同じ一覧
export function fileFingerprint(dir: string, exclude?: string): string {
  return fingerprintList(dir, exclude)
    .map((f) => `${f.sha256}  ./${f.path}\n`)
    .join("");
}

// 依存の写しの指紋の一覧（input/deps-files.sha256）: ファイルごとの sha256 の後に、リンクごとの `link <パス> -> <リンク先>`。
// 後の段階では作り直してこのファイルと比べる（担当が写しを変えていないこと）
export function depsFingerprint(depsDir: string): string {
  const entries = walkEntries(depsDir);
  const links = entries.filter((e) => e.kind === "link").map((e) => `link ${e.rel} -> ${readlinkSync(e.path)}\n`);
  return fileFingerprint(depsDir) + links.join("");
}

// 共通入力の指紋（manifest.md 自身を除く input/ の各ファイル）。後の段階では作り直して prepare の inputs と比べる
export function inputFingerprint(work: string): FileHash[] {
  return fingerprintList(join(work, "input"), "manifest.md");
}

// ---- 限定 clone ----

export interface CloneCheck {
  name: string;
  command: string;
  expected: string;
  output: string;
  ok: boolean;
}

// 担当用の限定 clone の確認（parent.md 2.1節）。後の段階でもやり直し、prepare の clone.checks と同じ結果になることを確かめる
export function cloneChecks(clone: string, head: string, mergeBase: string, origins: string[]): CloneCheck[] {
  const text = (...args: string[]) => {
    const p = git(clone, ...args);
    return p.code === 0 ? p.stdout.toString().trim() : `失敗（${failure(p)}）`;
  };
  const lines = (s: string) => new Set(s.split("\n").filter(Boolean));
  const check = (name: string, command: string, expected: string, output: string, ok: boolean): CloneCheck => ({ name, command, expected, output, ok });
  const refs = text("for-each-ref");
  const remotes = text("remote", "-v");
  const alternates = existsSync(join(clone, ".git/objects/info/alternates"));
  const fetchHead = existsSync(join(clone, ".git/FETCH_HEAD"));
  const resolved = text("rev-parse", "HEAD");
  const ancestor = git(clone, "merge-base", "--is-ancestor", mergeBase, head).code === 0;
  const commits = `${text("rev-list", "--count", "--all")} ${text("rev-list", "--count", head)}`;
  const all = lines(text("cat-file", "--batch-all-objects", "--batch-check=%(objectname)"));
  const reachable = lines(text("rev-list", "--objects", "--all").replace(/ .*$/gm, ""));
  const index = text("ls-files");
  const tree = existsSync(clone) ? readdirSync(clone).sort() : [];
  const needles = [...new Set(origins)].map((o) => Buffer.from(o));
  const leaks = walkEntries(join(clone, ".git"))
    .filter((e) => e.kind === "file" && !e.rel.startsWith("./objects/"))
    .filter((e) => needles.some((n) => readFileSync(e.path).includes(n)))
    .map((e) => e.rel.slice(2));
  const [allCount, headCount] = commits.split(" ");
  return [
    check("ref が無い", "git -C <clone> for-each-ref", "出力なし", refs, refs === ""),
    check("remote が無い", "git -C <clone> remote -v", "出力なし", remotes, remotes === ""),
    check("alternates が無い", "test ! -e <clone>/.git/objects/info/alternates", "なし", alternates ? "あり" : "なし", !alternates),
    check("FETCH_HEAD が無い", "test ! -e <clone>/.git/FETCH_HEAD", "なし", fetchHead ? "あり" : "なし", !fetchHead),
    check("HEAD が head", "git -C <clone> rev-parse HEAD", head, resolved, resolved === head),
    check("merge-base が head の祖先", "git -C <clone> merge-base --is-ancestor <merge-base> <head>", "終了コード 0", ancestor ? "終了コード 0" : "0 以外", ancestor),
    check("commit が head の祖先だけ", "git -C <clone> rev-list --count --all と rev-list --count <head>", "2つが一致", commits, allCount === headCount && allCount !== undefined),
    check(
      "head から辿れない object が無い",
      "git -C <clone> cat-file --batch-all-objects の数と rev-list --objects --all の数",
      "2つが一致",
      `${all.size} ${reachable.size}`,
      all.size === reachable.size && [...all].every((o) => reachable.has(o)),
    ),
    check("index が空", "git -C <clone> ls-files | wc -l", "0", String(index ? index.split("\n").length : 0), index === ""),
    check("作業ツリーが空", "ls -A <clone>", ".git", tree.join(" "), tree.length === 1 && tree[0] === ".git"),
    check("元のリポジトリのパスを持たない", "grep -rlF <元のリポジトリ> <clone>/.git --exclude-dir=objects", "出力なし", leaks.join("\n"), leaks.length === 0),
  ];
}

export function renderCloneRecord(origin: string, clone: string, head: string, mergeBase: string, checks: CloneCheck[], creation: string[]): string {
  const out = [
    "# 担当用の限定 clone の確認",
    "",
    `- 元のリポジトリ: \`${origin}\``,
    `- 限定 clone: \`${clone}\``,
    `- head: \`${head}\``,
    `- merge-base: \`${mergeBase}\``,
    `- 確認した時刻: ${now()}`,
    `- 結果: ${creation.length === 0 && checks.every((c) => c.ok) ? "すべて合格" : "不合格あり"}`,
    "",
    "## 作成",
    "",
    "```sh",
    "git init -q <clone>",
    "git -C <clone> -c gc.auto=0 -c maintenance.auto=false fetch -q --no-tags --no-write-fetch-head \\",
    "  --upload-pack='git -c uploadpack.allowAnySHA1InWant=true upload-pack' <元のリポジトリ> <head>",
    "git -C <clone> update-ref --no-deref HEAD <head>",
    "```",
    "",
    ...(creation.length > 0 ? [`作成の失敗: ${creation.join("・")}`, ""] : []),
  ];
  for (const c of checks) {
    out.push(`## ${c.name}（${c.ok ? "合格" : "不合格"}）`, "", `- コマンド: \`${c.command}\``, `- 期待: ${c.expected}`, "- 出力:", "", "```text", c.output, "```", "");
  }
  return out.join("\n");
}

function makeClone(origin: string, clone: string, head: string): string[] {
  const steps: [string, string[]][] = [
    ["git init", ["git", "init", "-q", clone]],
    [
      "fetch",
      [
        "git",
        "-C",
        clone,
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "fetch",
        "-q",
        "--no-tags",
        "--no-write-fetch-head",
        "--upload-pack=git -c uploadpack.allowAnySHA1InWant=true upload-pack",
        origin,
        head,
      ],
    ],
    ["update-ref", ["git", "-C", clone, "update-ref", "--no-deref", "HEAD", head]],
  ];
  for (const [name, cmd] of steps) {
    const p = exec(cmd);
    if (p.code !== 0) return [`${name}（${failure(p)}）`];
  }
  return [];
}

// ---- 依存の写し ----

const LOCKFILES: Record<string, string> = { "bun.lock": "bun", "bun.lockb": "bun", "package-lock.json": "npm", "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn" };
// mode: local で未コミットの変更が触れていれば manifest.md に書くパッケージの定義
const PACKAGE_FILES = new Set([...Object.keys(LOCKFILES), "package.json", ".yarnrc.yml", ".npmrc", "bunfig.toml", "pnpm-workspace.yaml"]);

interface Plan {
  manager: string;
  lockfile: string;
  install: string[];
  version: string[];
  registry: string[] | null;
}

interface Deps {
  prepared: boolean;
  reason: string | null;
  manager: string | null;
  lockfile: string | null;
  lockfileSha256: string | null;
  command: string | null;
  exitCode: number | null;
  version: string | null;
  registry: string | null;
  setupLogSha256: string | null;
  files: number;
  links: number;
  fingerprintSha256: string | null;
  note: string | null;
}

const quote = (cmd: string[]) => cmd.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(" ");

// 固定版のルートの lockfile から、lockfile どおりに入れ、スクリプトを実行しない準備のコマンドを決める。決められなければ理由
function planDeps(clone: string, head: string): Plan | string {
  const root = git(clone, "ls-tree", "-z", head)
    .stdout.toString()
    .split("\0")
    .filter(Boolean)
    .map((l) => ({ type: l.split(" ")[1], name: l.split("\t")[1] ?? "" }));
  const found = root.filter((e) => e.type === "blob" && e.name in LOCKFILES).map((e) => e.name);
  if (found.length === 0) {
    const nested = gitText(clone, "ls-tree", "-r", "--name-only", head)
      .split("\n")
      .filter((p) => basename(p) in LOCKFILES);
    return nested.length > 0 ? `lockfile がルート以外にしか無い（${nested.slice(0, 5).join("・")}${nested.length > 5 ? " ほか" : ""}）` : "lockfile が無い";
  }
  const show = (path: string) => {
    const p = git(clone, "show", `${head}:${path}`);
    return p.code === 0 ? p.stdout.toString() : null;
  };
  let managers = [...new Set(found.map((f) => LOCKFILES[f] ?? ""))];
  if (managers.length > 1) {
    let declared = "";
    try {
      declared = String((JSON.parse(show("package.json") ?? "{}") as Json).packageManager ?? "").split("@")[0] ?? "";
    } catch {
      declared = "";
    }
    if (!managers.includes(declared)) return `どれを使うか固定版から決められない複数の lockfile がある（${found.join("・")}）`;
    managers = [declared];
  }
  const manager = managers[0] ?? "";
  const lockfile = found.find((f) => LOCKFILES[f] === manager) ?? "";
  if (manager === "bun") return { manager, lockfile, install: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"], version: ["bun", "--version"], registry: null };
  if (manager === "npm") return { manager, lockfile, install: ["npm", "ci", "--ignore-scripts"], version: ["npm", "--version"], registry: ["npm", "config", "get", "registry"] };
  if (manager === "pnpm") {
    return { manager, lockfile, install: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"], version: ["pnpm", "--version"], registry: ["pnpm", "config", "get", "registry"] };
  }
  const lock = show(lockfile) ?? "";
  if (/^# yarn lockfile v1\s*$/m.test(lock)) {
    return { manager: "yarn v1", lockfile, install: ["yarn", "install", "--frozen-lockfile", "--ignore-scripts"], version: ["yarn", "--version"], registry: ["yarn", "config", "get", "registry"] };
  }
  if (!/^__metadata:\s*$/m.test(lock)) return "yarn.lock の形式（v1 か Yarn 2 以降か）を固定版から決められない";
  const yarnPath = /^yarnPath:\s*["']?(.+?)["']?\s*$/m.exec(show(".yarnrc.yml") ?? "")?.[1];
  if (!yarnPath) return "Yarn 2 以降の yarn.lock だが、.yarnrc.yml の yarnPath が無く、使う Yarn の版を固定版から決められない";
  if (isAbsolute(yarnPath) || yarnPath.split("/").some((s) => s === ".." || s === "") || show(yarnPath) === null) {
    return `.yarnrc.yml の yarnPath（${yarnPath}）が固定版のリポジトリの中のファイルを指していない`;
  }
  return {
    manager: "yarn berry",
    lockfile,
    install: ["node", yarnPath, "install", "--immutable", "--mode=skip-build"],
    version: ["node", yarnPath, "--version"],
    registry: ["node", yarnPath, "config", "get", "npmRegistryServer"],
  };
}

// 写しの中のリンクはリンクのまま、ファイルは内容と実行の許可を保って写す
function copyTree(src: string, dest: string): void {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), dest);
  else if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) copyTree(join(src, name), join(dest, name));
  } else if (st.isFile()) copyFileSync(src, dest);
}

// 作業領域の配下の node_modules だけを、同じ相対パスで写す（node_modules の中へは降りない）
function copyNodeModules(build: string, deps: string): number {
  let count = 0;
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (!st.isDirectory()) continue;
      const r = rel ? `${rel}/${name}` : name;
      if (name === "node_modules") {
        copyTree(path, join(deps, r));
        count++;
      } else walk(path, r);
    }
  };
  walk(build, "");
  return count;
}

function prepareDeps(work: string, clone: string, head: string, changed: string[]): Deps {
  const deps = join(work, "deps");
  const record = join(work, "parent/deps");
  const result: Deps = {
    prepared: false,
    reason: null,
    manager: null,
    lockfile: null,
    lockfileSha256: null,
    command: null,
    exitCode: null,
    version: null,
    registry: null,
    setupLogSha256: null,
    files: 0,
    links: 0,
    fingerprintSha256: null,
    note: null,
  };
  const touched = changed.filter((p) => PACKAGE_FILES.has(basename(p)));
  if (touched.length > 0) result.note = `未コミットの変更がパッケージの定義・lockfile を変えている（${touched.join("・")}）が、写しは土台の HEAD の lockfile から作った`;
  const plan = planDeps(clone, head);
  const build = join(record, "build");
  if (typeof plan === "string") result.reason = plan;
  else {
    result.manager = plan.manager;
    result.lockfile = plan.lockfile;
    result.lockfileSha256 = sha256(git(clone, "show", `${head}:${plan.lockfile}`).stdout);
    result.command = quote(plan.install);
    mkdirSync(build, { recursive: true });
    const extract = exec(["bash", "-c", 'set -o pipefail; git -C "$1" archive "$2" | tar -x -C "$3"', "bash", clone, head, build]);
    if (extract.code !== 0) result.reason = `固定版を展開できない（${failure(extract)}）`;
    else {
      const log = join(record, "setup.log");
      const fd = openSync(log, "w");
      const p = spawnSync(plan.install[0] ?? "", plan.install.slice(1), { cwd: build, stdio: ["ignore", fd, fd] });
      closeSync(fd);
      if (p.error) writeFileSync(log, `${p.error.message}\n`, { flag: "a" });
      result.exitCode = p.status;
      result.setupLogSha256 = sha256(readFileSync(log));
      const version = exec(plan.version, { cwd: build });
      result.version = version.code === 0 ? version.stdout.toString().trim() : `取得できず（${failure(version)}）`;
      if (plan.registry) {
        const registry = exec(plan.registry, { cwd: build });
        result.registry = registry.code === 0 ? registry.stdout.toString().trim() : `取得できず（${failure(registry)}）`;
      } else {
        const bunfig = existsSync(join(build, "bunfig.toml")) ? readFileSync(join(build, "bunfig.toml"), "utf8") : "";
        const configured = /^\s*registry\s*=\s*"([^"]+)"/m.exec(bunfig)?.[1];
        result.registry = configured ? `${configured}（bunfig.toml）` : "https://registry.npmjs.org/（bun の既定。bunfig.toml に registry なし）";
      }
      if (p.error) result.reason = `準備のコマンドを起動できない（${p.error.message}）`;
      else if (p.status !== 0) result.reason = `準備の終了コードが 0 以外（${p.status ?? p.signal}）`;
      else if (copyNodeModules(build, deps) === 0) result.reason = "準備は終了コード 0 だったが node_modules が作られなかった（写せる配布物が無い）";
      else {
        const list = depsFingerprint(deps);
        writeFileSync(join(work, "input/deps-files.sha256"), list);
        result.prepared = true;
        result.fingerprintSha256 = sha256(list);
        result.files = list.split("\n").filter((l) => l && !l.startsWith("link ")).length;
        result.links = list.split("\n").filter((l) => l.startsWith("link ")).length;
      }
    }
  }
  rmSync(build, { recursive: true, force: true });
  if (!result.prepared) rmSync(deps, { recursive: true, force: true });
  writeFileSync(
    join(record, "record.md"),
    [
      "# 依存の準備の記録（担当に渡さない）",
      "",
      `- 結果: ${result.prepared ? "準備した" : `準備しなかった・できなかった（${result.reason}）`}`,
      `- パッケージ管理とその版: ${result.manager ?? "なし"}${result.version ? ` ${result.version}` : ""}`,
      `- lockfile: ${result.lockfile ? `\`${result.lockfile}@${head}\`（sha256 \`${result.lockfileSha256}\`）` : "なし"}`,
      `- 準備のコマンド: ${result.command ? `\`${result.command}\`（作業領域 \`${build}\` で実行）` : "なし"}`,
      `- 終了コード: ${result.exitCode ?? "なし"}`,
      `- 取得元: ${result.registry ?? "なし"}`,
      `- setup.log の sha256: ${result.setupLogSha256 ?? "なし"}`,
      `- 展開した作業領域: 片付けた（${now()}）`,
      ...(result.note ? [`- ${result.note}`] : []),
      "",
    ].join("\n"),
  );
  return result;
}

// ---- 要求 ----

interface Requirements {
  // input/ からの相対パスごとの出典
  sources: Map<string, string>;
  unavailable: { item: string; reason: string }[];
  // target.md の Issue・要求資料・計画の出典の行
  issueLine: string;
  planLine: string;
}

interface DocRow {
  id: number;
  kind?: string;
  path?: string;
}

function parseJson(p: Proc): unknown {
  try {
    return JSON.parse(p.stdout.toString());
  } catch {
    return undefined;
  }
}

function docContent(id: number | string): { content: string; path: string; kind: string } | string {
  const p = nod(["--json", "doc", "show", String(id)]);
  const doc = parseJson(p) as { content?: unknown; path?: unknown; kind?: unknown } | undefined;
  if (p.code !== 0 || typeof doc?.content !== "string") return `nod doc show が失敗（${failure(p)}）`;
  return { content: doc.content, path: String(doc.path ?? ""), kind: String(doc.kind ?? "") };
}

function workspaceRules(repo: string, req: Requirements, dir: string): void {
  const at = now();
  const p = nod(["-w", repo, "workspace", "rules", "show"]);
  if (p.code !== 0) req.unavailable.push({ item: "Workspace の規約", reason: `nod workspace rules show が失敗（${failure(p)}）` });
  else {
    writeFileSync(join(dir, "workspace-rules.md"), p.stdout);
    req.sources.set("requirements/workspace-rules.md", `Workspace の規約（nod -w <対象リポジトリ> workspace rules show、${at}）`);
  }
}

// Issue の要求（タイトルと本文・kind=spec・計画の出典・Workspace の規約）を dir へ写す（prepare は input/requirements/、保存直前の再照合は取り直し先）。
// nod issue show の全出力は snapshot に残す
function issueRequirements(dir: string, snapshot: string, repo: string, id: string): Requirements {
  const req: Requirements = { sources: new Map(), unavailable: [], issueLine: id, planLine: "計画の出典なし" };
  const at = now();
  const p = nod(["--json", "issue", "show", id]);
  writeFileSync(snapshot, p.stdout);
  const issue = parseJson(p) as { title?: unknown; description?: unknown; documents?: DocRow[]; plan?: { source?: unknown } | null } | undefined;
  if (p.code !== 0 || typeof issue?.title !== "string") {
    req.unavailable.push({ item: `Issue ${id}`, reason: `nod issue show が失敗（${failure(p)}）。Issue 本文・kind=spec・計画の出典を写せない` });
    req.planLine = "計画の出典を確かめられず不足（Issue を取得できない）";
  } else {
    writeFileSync(join(dir, "issue.md"), `# ${issue.title}\n\n${typeof issue.description === "string" ? issue.description : ""}\n`);
    req.sources.set("requirements/issue.md", `Issue ${id} のタイトルと本文（${at}）`);
    const documents = Array.isArray(issue.documents) ? issue.documents : [];
    for (const d of documents.filter((d) => d.kind === "spec")) {
      const doc = docContent(d.id);
      if (typeof doc === "string") req.unavailable.push({ item: `Document ${d.id}（kind=spec、${d.path}）`, reason: doc });
      else {
        writeFileSync(join(dir, `spec-${d.id}.md`), doc.content);
        req.sources.set(`requirements/spec-${d.id}.md`, `Document ${d.id}（kind=spec、${doc.path}、${now()}）`);
      }
    }
    const source = typeof issue.plan?.source === "string" && issue.plan.source !== "" ? issue.plan.source : null;
    if (source) {
      let plan = documents.find((d) => d.kind === "plan" && d.path === source);
      if (!plan) {
        const list = parseJson(nod(["--json", "doc", "list"]));
        plan = (Array.isArray(list) ? (list as DocRow[]) : []).find((d) => d.kind === "plan" && d.path === source);
      }
      const doc = plan ? docContent(plan.id) : "plan.source の path と一致する kind=plan の Document が無い";
      if (!plan || typeof doc === "string") {
        req.planLine = `計画の出典を解決できず不足（${source}）`;
        req.unavailable.push({ item: `計画の出典（${source}）`, reason: typeof doc === "string" ? doc : "本文を読めない" });
      } else {
        writeFileSync(join(dir, `plan-${plan.id}.md`), doc.content);
        req.sources.set(`requirements/plan-${plan.id}.md`, `Document ${plan.id}（kind=plan、Issue の計画の出典 ${source}、${now()}）`);
        req.planLine = `requirements/plan-${plan.id}.md（Issue の plan.source が指す Document ${plan.id}）`;
      }
    }
  }
  workspaceRules(repo, req, dir);
  return req;
}

function requestRequirements(dir: string, repo: string, requests: { key: string; value: string }[]): Requirements {
  const req: Requirements = { sources: new Map(), unavailable: [], issueLine: "なし", planLine: "Issue なし" };
  requests.forEach((r, i) => {
    const name = `requirements/request-${i + 1}.md`;
    if (r.key === "request") {
      if (!existsSync(r.value)) req.unavailable.push({ item: `利用者が明示した要求のファイル ${r.value}`, reason: "ファイルが無い" });
      else {
        writeFileSync(join(dir, `request-${i + 1}.md`), readFileSync(r.value));
        req.sources.set(name, `利用者が明示した要求のファイル（${r.value}、${now()}）`);
      }
    } else {
      const doc = docContent(r.value);
      if (typeof doc === "string") req.unavailable.push({ item: `利用者が明示した要求の Document ${r.value}`, reason: doc });
      else {
        writeFileSync(join(dir, `request-${i + 1}.md`), doc.content);
        req.sources.set(name, `利用者が明示した要求の Document ${r.value}（kind=${doc.kind}、${doc.path}、${now()}）`);
      }
    }
  });
  req.issueLine = requests.length > 0 ? `なし（明示された要求: ${[...req.sources.keys()].join("・")}）` : "なし（Workspace の規約以外の要求資料なし）";
  workspaceRules(repo, req, dir);
  return req;
}

// ---- 評価用の事例（常設データセットの inputs/<case-id>/） ----

interface Case {
  dir: string;
  id: string;
  text: string;
  repo: string;
  base: string;
  head: string;
  // 事例の manifest.md の表（ファイルの相対パスごとの sha256）
  hashes: Map<string, string>;
  unavailable: string[];
}

function readCase(dir: string): Case {
  const caseFile = join(dir, "case.md");
  const manifestFile = join(dir, "manifest.md");
  if (!existsSync(caseFile) || !existsSync(manifestFile)) throw new UsageError(`--case に case.md と manifest.md がありません: ${dir}`);
  const text = readFileSync(caseFile, "utf8");
  const field = (name: string) => new RegExp(`^- ${name}: \`([^\`]+)\``, "m").exec(text)?.[1];
  const repo = field("対象リポジトリ");
  const base = field("基点の指定");
  const head = field("head");
  const mode = field("mode");
  if (!repo || !base || !head || mode !== "commit") throw new UsageError(`case.md から対象リポジトリ・基点の指定・head・mode: commit を読めません: ${caseFile}`);
  const manifest = readFileSync(manifestFile, "utf8");
  const hashes = new Map<string, string>();
  for (const m of manifest.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`/gm)) hashes.set(m[1] ?? "", m[2] ?? "");
  const section = /^## 取得できなかった資料と理由\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(manifest)?.[1] ?? "";
  const unavailable = section.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  return { dir, id: basename(dir), text, repo, base, head, hashes, unavailable };
}

// 事例の requirements/（と standards/ の中身）を dir（prepare は input/requirements/）へ写し、写した sha256 を事例の manifest.md と比べる。食い違いを返す
function caseRequirements(dir: string, c: Case): { req: Requirements; mismatches: string[] } {
  const req: Requirements = { sources: new Map(), unavailable: c.unavailable.map((reason) => ({ item: "事例の manifest.md の記載", reason })), issueLine: "", planLine: "" };
  const mismatches: string[] = [];
  const caseSha = sha256(readFileSync(join(c.dir, "case.md")));
  if (c.hashes.get("case.md") !== caseSha) mismatches.push(`case.md（manifest.md: ${c.hashes.get("case.md") ?? "記載なし"}、実物: ${caseSha}）`);
  const copied = new Set<string>();
  for (const sub of ["requirements", "standards"]) {
    for (const e of walkEntries(join(c.dir, sub))) {
      const rel = `${sub}/${e.rel.slice(2)}`;
      const dest = join(dir, e.rel.slice(2));
      if (e.kind !== "file" || existsSync(dest)) {
        mismatches.push(`${rel}（${e.kind !== "file" ? "通常のファイルではない" : "写し先の名前が重なる"}）`);
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(e.path, dest);
      copied.add(rel);
      const got = sha256(readFileSync(dest));
      if (c.hashes.get(rel) !== got) mismatches.push(`${rel}（manifest.md: ${c.hashes.get(rel) ?? "記載なし"}、写し: ${got}）`);
      req.sources.set(`requirements/${e.rel.slice(2)}`, `inputs/${c.id}/${rel}（事例の manifest.md の sha256 と一致を確認）`);
    }
  }
  for (const rel of c.hashes.keys()) if (/^(requirements|standards)\//.test(rel) && !copied.has(rel)) mismatches.push(`${rel}（manifest.md にあるが事例に無い）`);
  return { req, mismatches };
}

// ---- prepare ----

function prepare(args: string[]): Outcome {
  const o = parseOptions(args, ["work", "work-root", "repo", "mode", "base", "head", "pr", "issue", "case"], ["untracked", "request", "request-doc"]);
  const caseDir = absolute("case", o.one.get("case"));
  const kase = caseDir ? readCase(caseDir) : null;
  if (kase && ["mode", "base", "head", "pr", "issue"].some((k) => o.one.has(k))) throw new UsageError("--case と --mode・--base・--head・--pr・--issue は同時に使えません（事例の case.md から読みます）");
  if (kase && o.many.length > 0) throw new UsageError("--case と --untracked・--request・--request-doc は同時に使えません");
  const repo = absolute("repo", o.one.get("repo") ?? kase?.repo);
  const mode = kase ? "commit" : o.one.get("mode");
  const base = kase?.base ?? o.one.get("base");
  const headArg = kase?.head ?? o.one.get("head");
  const pr = o.one.get("pr");
  const issue = o.one.get("issue");
  const untracked = o.many.filter((m) => m.key === "untracked").map((m) => m.value);
  const requests = o.many.filter((m) => m.key !== "untracked");
  if (!repo || !base || (mode !== "commit" && mode !== "local")) {
    throw new UsageError(
      "使い方: bun review.ts prepare --repo <絶対パス> --base <基点の指定> --mode commit --head <SHA か ref> [--pr <URL>] | --mode local [--untracked <相対パス>]... ; [--issue <ID> | --request <絶対パス>... | --request-doc <Document ID>...] | --case <inputs/<case-id> の絶対パス> [--repo <絶対パス>] ; [--work <W の絶対パス> | --work-root <絶対パス>]",
    );
  }
  if (issue && requests.length > 0) throw new UsageError("--issue と --request・--request-doc は同時に使えません（Issue の無い単独レビューだけが明示の要求を使います）");
  for (const r of requests) if (r.key === "request" && (!isAbsolute(r.value) || !existsSync(r.value))) throw new UsageError(`--request は存在するファイルの絶対パスで指定してください: ${r.value}`);
  if (git(repo, "rev-parse", "--git-dir").code !== 0) throw new UsageError(`--repo が Git のリポジトリではありません: ${repo}`);
  const resolve = (rev: string, name: string) => {
    const p = git(repo, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`);
    if (p.code !== 0) throw new UsageError(`${name} を commit に解決できません: ${rev}`);
    return p.stdout.toString().trim();
  };
  let head: string;
  let headSource: Json | null = null;
  if (mode === "commit") {
    if (!headArg) throw new UsageError("mode: commit には --head が要ります");
    if (untracked.length > 0) throw new UsageError("--untracked は mode: local だけで使えます");
    if (pr && !SHA.test(headArg)) throw new UsageError("--pr を指定するときは、PR から解決した head の40桁の SHA を --head に渡してください");
    head = resolve(headArg, "--head");
    const symbolic = git(repo, "rev-parse", "--symbolic-full-name", headArg).stdout.toString().trim();
    headSource = pr ? { kind: "pr", pr } : kase ? { kind: "none" } : symbolic ? { kind: "ref", ref: headArg } : { kind: "none" };
  } else {
    if (headArg || pr) throw new UsageError("mode: local では --head・--pr を使いません（土台の HEAD を固定します）");
    head = resolve("HEAD", "土台の HEAD");
    for (const u of untracked) {
      if (isAbsolute(u) || u.split("/").some((s) => s === "" || s === "." || s === "..")) throw new UsageError(`--untracked はリポジトリのルートからの相対パスで指定してください: ${u}`);
      let st: Stats;
      try {
        st = lstatSync(join(repo, u));
      } catch {
        throw new UsageError(`--untracked のファイルがありません: ${u}`);
      }
      if (!st.isFile() && !st.isSymbolicLink()) throw new UsageError(`--untracked は通常のファイルかリンクを指定してください: ${u}`);
      if (git(repo, "ls-files", "--error-unmatch", "--", u).code === 0) throw new UsageError(`--untracked は未追跡のファイルだけを指定してください（追跡済み）: ${u}`);
    }
  }
  resolve(base, "--base");
  const mb = git(repo, "merge-base", base, head);
  if (mb.code !== 0) throw new UsageError(`基点 ${base} と head ${head} の merge-base を求められません`);
  const mergeBase = mb.stdout.toString().trim();

  // 作業ディレクトリ
  const workArg = absolute("work", o.one.get("work"));
  const work = workArg ?? join(absolute("work-root", o.one.get("work-root")) ?? join(homedir(), ".local/share/nod/code-reviews"), randomUUID());
  if (existsSync(work) && readdirSync(work).length > 0) throw new UsageError(`--work は存在しないか空のディレクトリにしてください: ${work}`);
  for (const d of ["input/requirements", "standards/notes", "spec/notes", "refute-input", "refute/notes", "parent/deps"]) mkdirSync(join(work, d), { recursive: true });
  const clone = join(work, "repo");
  const startedAt = now();
  const result: Json = {
    runId: basename(work),
    work,
    ready: false,
    status: "未実施",
    reason: null,
    score: null,
    merge: null,
    mode,
    repo,
    base,
    mergeBase,
    head,
    issue: issue ?? null,
    case: kase ? kase.id : null,
    // 事例の入力（inputs/<case-id>/）の絶対パス。受け入れ確認への写し（acceptance-input）が、事例の入力に固定した証拠をここから写す
    caseDir: kase ? kase.dir : null,
    untracked,
    // 利用者が明示した要求（Issue の無い単独レビュー）。保存直前の再照合で同じ方法で取り直す
    requests,
    headSource,
    startedAt,
    secrets: [],
    changedPaths: 0,
    clone: null,
    deps: null,
    inputs: [],
    manifestSha256: null,
    unavailable: [],
  };
  const notRun = (reason: string): Outcome => {
    Object.assign(result, { ready: false, status: "未実施", reason, score: NOT_RUN_SCORE, merge: NOT_RUN_MERGE });
    return { work, result };
  };

  // head を固定した元（mode: commit。親専用。10節の8と11節で現在の head を取り直す）
  if (headSource) {
    const kind = headSource.kind === "pr" ? "PR" : headSource.kind === "ref" ? "ref" : "ref なし";
    const lines = ["# head を固定した元", "", `- 種類: ${kind}`];
    if (headSource.kind === "pr") lines.push(`- PR: ${pr}`, `- 取り直し: \`gh pr view ${pr} --json headRefOid,baseRefName\``);
    if (headSource.kind === "ref") lines.push(`- リポジトリ: \`${repo}\``, `- ref: \`${headArg}\``, `- 取り直し: \`git -C ${repo} rev-parse ${headArg}\``);
    if (kase) lines.push(`- 評価用の事例 inputs/${kase.id} の固定 SHA`);
    lines.push(`- 基点の指定: \`${base}\``, `- head: \`${head}\``, `- 固定した時刻: ${startedAt}`, "");
    writeFileSync(join(work, "parent/head-source.md"), lines.join("\n"));
  }

  // 評価用の事例は、nod から取らずに固定資料を写して sha256 を確かめる
  let req: Requirements | null = null;
  if (kase) {
    const c = caseRequirements(join(work, "input/requirements"), kase);
    if (c.mismatches.length > 0) return notRun(`事例の入力を固定できない（sha256 が事例の manifest.md と一致しない: ${c.mismatches.join("・")}）`);
    req = c.req;
  }

  // 本文を写す前に、変更されたパスの名前だけで秘密候補と空差分を調べる
  const names = (...args: string[]) =>
    git(repo, ...args)
      .stdout.toString()
      .split("\0")
      .filter(Boolean);
  const committed = names("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", mergeBase, head);
  const uncommitted = mode === "local" ? names("--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", "HEAD") : [];
  const changed = [...new Set([...committed, ...uncommitted, ...untracked])];
  const secrets = changed.filter((p) => SECRET.test(p));
  result.changedPaths = changed.length;
  result.secrets = secrets;
  if (secrets.length > 0) return notRun(`秘密情報を含み得る ${secrets.join("・")} が差分にあり、必要な範囲を利用者が確かめる必要がある`);
  if (changed.length === 0) return notRun("差分なし");

  // 担当用の限定 clone
  const creation = makeClone(repo, clone, head);
  const origins = [repo, realpathSync(repo)];
  const checks = creation.length > 0 ? [] : cloneChecks(clone, head, mergeBase, origins);
  const failed = [...creation, ...checks.filter((c) => !c.ok).map((c) => c.name)];
  writeFileSync(join(work, "parent/clone.md"), renderCloneRecord(repo, clone, head, mergeBase, checks, creation));
  result.clone = { ok: failed.length === 0, failed, checks };
  if (failed.length > 0) return notRun(`担当用の限定 clone を作れない（${failed.join("・")}）`);

  // 未コミットの変更（mode: local）
  if (mode === "local") {
    const local = join(work, "input/local");
    mkdirSync(local, { recursive: true });
    const diff = git(repo, "--no-optional-locks", "diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD");
    if (diff.code !== 0) throw new Error(`未コミットの差分を取れません: ${diff.stderr}`);
    writeFileSync(join(local, "changes.diff"), diff.stdout);
    for (const u of untracked) {
      const dest = join(local, "untracked", u);
      mkdirSync(dirname(dest), { recursive: true });
      copyTree(join(repo, u), dest);
    }
  }

  // 依存の写し
  const deps = prepareDeps(work, clone, head, mode === "local" ? [...uncommitted, ...untracked] : []);
  result.deps = deps;

  // 要求の原文
  if (!req) req = issue ? issueRequirements(join(work, "input/requirements"), join(work, "parent/issue-snapshot.json"), repo, issue) : requestRequirements(join(work, "input/requirements"), repo, requests);
  result.unavailable = req.unavailable;

  // target.md
  const depsLine = deps.prepared ? `\`${join(work, "deps")}/\`` : "依存の写しなし（理由は manifest.md）";
  let target: string;
  if (kase) {
    target = kase.text.replace(/^- 対象リポジトリ: `[^`]+`.*$/m, `- 対象リポジトリ: \`${clone}\`\n- 依存の写し: ${depsLine}`);
  } else {
    const lines = [
      "# 対象",
      "",
      `- 対象リポジトリ: \`${clone}\``,
      `- 依存の写し: ${depsLine}`,
      `- 基点の指定: \`${base}\``,
      `- merge-base: \`${mergeBase}\``,
      `- head: \`${head}\`${mode === "local" ? "（土台の HEAD）" : ""}`,
      `- mode: \`${mode}\``,
      `- Issue: ${req.issueLine}`,
      `- 計画の出典: ${req.planLine}`,
    ];
    if (mode === "local") {
      lines.push(`- 土台の HEAD: \`${head}\``, "- 未コミットの差分: `local/changes.diff`");
      lines.push(`- 指定された未追跡ファイル: ${untracked.length > 0 ? untracked.map((u) => `\`local/untracked/${u}\``).join("・") : "なし"}`);
    }
    target = `${lines.join("\n")}\n`;
  }
  writeFileSync(join(work, "input/target.md"), target);

  // manifest.md（input/ の各ファイルの sha256 と出典、取得できなかった資料、依存の写し）
  const sources = new Map<string, string>([
    ["target.md", kase ? `inputs/${kase.id}/case.md を写し、対象リポジトリの行を限定 clone に置き換え、依存の写しの行を足した（${now()}）` : `review.ts prepare が作成（${now()}）`],
    ["deps-files.sha256", "依存の写しの指紋の一覧（ファイルごとの sha256 とリンク先）"],
    ["local/changes.diff", `git diff --binary --no-ext-diff --no-textconv HEAD（土台の HEAD ${head}）`],
    ...req.sources,
  ]);
  const inputs = inputFingerprint(work);
  const source = (path: string) => sources.get(path) ?? (path.startsWith("local/untracked/") ? `指定された未追跡ファイル ${path.slice("local/untracked/".length)}（${now()}）` : "不明");
  const manifest = [
    "# 共通入力の目録",
    "",
    `runId: ${basename(work)}（review.ts prepare、${startedAt}）。対象版: head \`${head}\`、merge-base \`${mergeBase}\`。`,
    "",
    "## ファイルの sha256 と出典（manifest.md 自身を除く）",
    "",
    "| ファイル | sha256 | 出典 |",
    "|---|---|---|",
    ...inputs.map((i) => `| \`${i.path}\` | \`${i.sha256}\` | ${source(i.path)} |`),
    "",
    "## 取得できなかった資料と理由",
    "",
    ...(req.unavailable.length > 0 ? req.unavailable.map((u) => `- ${u.item}: ${u.reason}`) : ["- なし"]),
    "",
    "## 依存の写し",
    "",
    ...(deps.prepared
      ? [
          `- 場所: \`${join(work, "deps")}/\``,
          `- lockfile: \`${deps.lockfile}@${head}\`（sha256 \`${deps.lockfileSha256}\`）`,
          `- パッケージ管理とその版: ${deps.manager} ${deps.version}`,
          `- 準備のコマンド: \`${deps.command}\`（lockfile どおりに入れ、スクリプトを実行しない指定）、終了コード ${deps.exitCode}`,
          `- 取得元: ${deps.registry}`,
          `- 指紋の一覧: \`deps-files.sha256\`（ファイル ${deps.files} 件、リンク ${deps.links} 件）`,
        ]
      : [`- 依存の写しなし: ${deps.reason}${deps.lockfile ? `（lockfile \`${deps.lockfile}@${head}\`、sha256 \`${deps.lockfileSha256}\`）` : ""}`]),
    ...(deps.note ? [`- ${deps.note}`] : []),
    "",
  ]
    .join("\n")
    // nod のエラーや明示された要求のパスに出る元のリポジトリのパスを、担当へ渡す入力に入れない
    .replaceAll(realpathSync(repo), "<対象リポジトリ>")
    .replaceAll(repo, "<対象リポジトリ>");
  writeFileSync(join(work, "input/manifest.md"), manifest);
  Object.assign(result, { ready: true, status: "準備完了", inputs, manifestSha256: sha256(manifest) });
  return { work, result };
}

// ---- 担当・試行・段階ごとの同一性（parent.md 4〜6節。記録は親専用領域） ----

export type Role = "standards" | "spec" | "refute" | "acceptance";
// 同一性を確かめ直す段階。反証・受け入れ確認では、その担当への入力の写しも比べる
export type Stage = "explore" | "refute" | "acceptance";

const ROLES: Record<Role, { name: string; definition: string; output: string; stage: Stage }> = {
  standards: { name: "Standards 探索", definition: "code-reviewer-standards", output: "handoff.md", stage: "explore" },
  spec: { name: "Spec 探索", definition: "code-reviewer-spec", output: "handoff.md", stage: "explore" },
  refute: { name: "反証", definition: "code-reviewer-refute", output: "verdict.md", stage: "refute" },
  acceptance: { name: "受け入れ確認", definition: "code-reviewer-acceptance", output: "result.md", stage: "acceptance" },
};
const STAGE_NAMES: Record<Stage, string> = { explore: "探索", refute: "反証", acceptance: "受け入れ確認" };
// 段階ごとの担当への入力の写し。写しを作るサブコマンドは、出力（parent/<ディレクトリ名>.json）の files に写しの全ファイルの sha256 を、ready に固定できたかを書く
const STAGE_COPIES: Partial<Record<Stage, string>> = { refute: "refute-input", acceptance: "acceptance-input" };

const FAILURES = { invalid: "判定と無関係な無効", "usage-limit": "利用枠の上限", aborted: "利用者による中止" } as const;
type Failure = keyof typeof FAILURES;
const REFUTE_UNFIXED = "反証への入力を固定できず、反証の有効な結果なし";
const ACCEPTANCE_UNFIXED = "受け入れ確認への入力を固定できず、受け入れ確認の有効な結果なし";

interface Prepared {
  ready: boolean;
  status?: string;
  reason?: string | null;
  mode: "commit" | "local";
  repo: string;
  base: string;
  head: string;
  mergeBase: string;
  issue: string | null;
  case: string | null;
  caseDir?: string | null;
  untracked?: string[];
  requests?: { key: string; value: string }[];
  headSource?: { kind: "pr"; pr: string } | { kind: "ref"; ref: string } | { kind: "none" } | null;
  clone: { checks: CloneCheck[] } | null;
  deps: Deps | null;
  inputs: FileHash[];
  manifestSha256: string | null;
  // prepare の結果を作り始めた時刻（段階の記録 parent/stages.json が無い古い作業ディレクトリの計測の始まり）
  startedAt?: string;
}

export interface AgentRecord {
  role: Role;
  roleName: string;
  definition: string;
  attempt: number;
  agentId: string | null;
  // 委譲の開始（親が委譲する直前）と、親が次の工程へ進める最終返答を受け取った時刻（ISO 8601、UTC）
  startedAt: string;
  receivedAt: string | null;
}

export interface IdentityItem {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Identity {
  stage: Stage;
  trigger: string;
  at: string;
  ok: boolean;
  items: IdentityItem[];
}

export interface Violation {
  // parent.md の検査の番号（探索は5節、反証は7節、受け入れ確認は9節）
  no: number;
  message: string;
}

export interface CheckRecord {
  stage: Stage;
  role: Role;
  roleName: string;
  definition: string;
  attempt: number;
  agentId: string | null;
  file: string;
  sha256: string | null;
  valid: boolean;
  items: { no: number; name: string; ok: boolean }[];
  violations: Violation[];
  identity: Identity;
  // 担当のサブディレクトリの各ファイル（検査した時点）
  files: FileHash[];
  // 機械検査の外で親が確かめること
  parent: string;
  checkedAt: string;
}

export interface AttemptRecord {
  role: Role;
  roleName: string;
  definition: string;
  attempt: number;
  agentId: string | null;
  failure: Failure;
  failureLabel: string;
  reason: string;
  retries: string;
  movedTo: string;
  files: FileHash[];
  identity: Identity;
  redelegate: boolean;
  status: "未完了" | null;
  finalReason: string | null;
  retiredAt: string;
}

const cell = (s: string) => s.replaceAll("|", "\\|").replace(/\s*\n\s*/g, " ");

function readPrepared(work: string): Prepared {
  const file = join(work, "parent/prepare.json");
  const prep = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Prepared) : null;
  if (!prep?.ready) throw new UsageError(`prepare が準備完了を返した作業ディレクトリを --work に指定してください: ${work}`);
  return prep;
}

function loadWork(o: Options): { work: string; prep: Prepared } {
  const work = absolute("work", o.one.get("work"));
  if (!work) throw new UsageError("--work <W の絶対パス> が要ります");
  return { work, prep: readPrepared(work) };
}

function roleOf(value: string | undefined, allowed: readonly Role[]): Role {
  if (!allowed.includes(value as Role)) throw new UsageError(`--role は ${allowed.join("・")} のどれかにしてください: ${value ?? "なし"}`);
  return value as Role;
}

// parent/<name>.json の記録の一覧（Markdown の parent/<name>.md はこの一覧から作り直す）
function loadList<T>(work: string, name: string): T[] {
  const file = join(work, "parent", `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T[]) : [];
}

function saveList<T>(work: string, name: string, list: T[], markdown: string): void {
  writeFileSync(join(work, "parent", `${name}.json`), `${JSON.stringify(list, null, 2)}\n`);
  writeFileSync(join(work, "parent", `${name}.md`), markdown);
}

function compareFiles(expected: FileHash[], actual: FileHash[]): string[] {
  const got = new Map(actual.map((f) => [f.path, f.sha256]));
  const want = new Map(expected.map((f) => [f.path, f.sha256]));
  const out: string[] = [];
  for (const [path, hash] of want) if (got.get(path) !== hash) out.push(`${path}（記録 ${hash}、今 ${got.get(path) ?? "無い"}）`);
  for (const path of got.keys()) if (!want.has(path)) out.push(`${path}（記録に無いファイル）`);
  return out;
}

// 段階の境目での同一性の確認（parent.md 4.1節の2の3、5節の8、7節の7、9節の6）。共通入力・依存の写し・限定 clone を prepare の記録と比べ、
// 反証・受け入れ確認では担当への入力の写し（STAGE_COPIES）も、写したときの記録と比べる。結果を parent/identity.md（と identity.json）に足して返す
export function checkIdentity(work: string, stage: Stage, trigger: string): Identity {
  const prep = readPrepared(work);
  const items: IdentityItem[] = [];
  const inputs = compareFiles([...prep.inputs, { path: "manifest.md", sha256: prep.manifestSha256 ?? "" }], fingerprintList(join(work, "input")));
  items.push({ name: "共通入力（input/ の各ファイルと manifest.md の sha256 が prepare の記録と一致）", ok: inputs.length === 0, detail: inputs.join("・") || "一致" });
  const depsDir = join(work, "deps");
  if (prep.deps?.prepared) {
    const listFile = join(work, "input/deps-files.sha256");
    const recorded = existsSync(listFile) ? readFileSync(listFile, "utf8") : "";
    const rebuilt = depsFingerprint(depsDir);
    const was = new Set(recorded.split("\n").filter(Boolean));
    const now_ = new Set(rebuilt.split("\n").filter(Boolean));
    const differ = [...[...was].filter((l) => !now_.has(l)).map((l) => `記録だけ: ${l}`), ...[...now_].filter((l) => !was.has(l)).map((l) => `今だけ: ${l}`)];
    items.push({
      name: "依存の写し（指紋の一覧を作り直して input/deps-files.sha256 と一致）",
      ok: recorded !== "" && recorded === rebuilt,
      detail: differ.length > 0 ? differ.slice(0, 10).join("・") : recorded === rebuilt ? `一致（${now_.size} 行）` : "並びが違う",
    });
  } else {
    const exists = existsSync(depsDir);
    items.push({ name: "依存の写し（準備していないので deps/ が無い）", ok: !exists, detail: exists ? "deps/ がある" : "無い" });
  }
  const origins = [prep.repo, ...(existsSync(prep.repo) ? [realpathSync(prep.repo)] : [])];
  const before = new Map((prep.clone?.checks ?? []).map((c) => [c.name, c]));
  const differ = cloneChecks(join(work, "repo"), prep.head, prep.mergeBase, origins)
    .filter((c) => before.get(c.name)?.ok !== c.ok || before.get(c.name)?.output !== c.output)
    .map((c) => `${c.name}（prepare: ${before.get(c.name)?.output ?? "記録なし"}、今: ${c.output}）`);
  items.push({ name: "限定 clone（2.1節の確認をやり直して prepare の結果と一致）", ok: differ.length === 0, detail: differ.join("・") || "一致" });
  const copy = STAGE_COPIES[stage];
  if (copy) {
    const file = join(work, "parent", `${copy}.json`);
    const record = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { ready?: boolean; files?: FileHash[] }) : null;
    const diffs = record?.ready && record.files ? compareFiles(record.files, fingerprintList(join(work, copy))) : [`写しの記録（parent/${copy}.json の準備完了）が無い`];
    items.push({ name: `${copy}/（各ファイルの sha256 が写したときの記録と一致）`, ok: diffs.length === 0, detail: diffs.join("・") || "一致" });
  }
  const result: Identity = { stage, trigger, at: now(), ok: items.every((i) => i.ok), items };
  const list = [...loadList<Identity>(work, "identity"), result];
  const md = ["# 段階ごとの同一性の確認", ""];
  for (const r of list) {
    md.push(`## ${r.at} ${STAGE_NAMES[r.stage]}（${r.trigger}）: ${r.ok ? "一致" : "不一致"}`, "", "| 確認 | 結果 | 詳細 |", "|---|---|---|");
    md.push(...r.items.map((i) => `| ${cell(i.name)} | ${i.ok ? "一致" : "不一致"} | ${cell(i.detail)} |`), "");
  }
  saveList(work, "identity", list, md.join("\n"));
  return result;
}

function renderAgents(list: AgentRecord[]): string {
  return [
    "# 担当と試行",
    "",
    "委譲の開始は親が委譲する直前、最終返答の受領は親が次の工程へ進める最終返答を受け取った時点に、review.ts agent が記録した時刻（ISO 8601、UTC）。",
    "",
    "| 役割 | 定義名 | 試行 | 担当 ID | 委譲の開始 | 最終返答の受領 |",
    "|---|---|---|---|---|---|",
    ...list.map((a) => `| ${a.roleName} | ${a.definition} | ${a.attempt} | ${cell(a.agentId ?? "不明")} | ${a.startedAt} | ${a.receivedAt ?? "未受領"} |`),
    "",
  ].join("\n");
}

function renderAttempts(list: AttemptRecord[]): string {
  const out = [
    "# 無効な試行",
    "",
    "omp 内部の再試行は担当のセッションの中でハーネスが行った retry で、親による再委譲（試行の番号）とは別に書く。",
    "",
    "| 役割 | 定義名 | 試行 | 担当 ID | 失敗の種類 | 無効の理由 | omp 内部の再試行 | 隔離先 | 同じ入力 | 委譲し直し |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...list.map(
      (a) =>
        `| ${a.roleName} | ${a.definition} | ${a.attempt} | ${cell(a.agentId ?? "不明")} | ${a.failureLabel} | ${cell(a.reason)} | ${cell(a.retries)} | \`${a.movedTo}\` | ${a.identity.ok ? "一致" : "不一致"} | ${a.redelegate ? "する" : `しない（${a.status}、理由: ${a.finalReason}）`} |`,
    ),
    "",
  ];
  for (const a of list) {
    out.push(`## ${a.roleName} 試行 ${a.attempt}（${a.retiredAt}）`, "", "### 同じ入力の確認", "");
    out.push(...a.identity.items.map((i) => `- ${i.name}: ${i.ok ? "一致" : "不一致"}（${i.detail}）`), "", "### 隔離したファイルの sha256", "", "```text");
    out.push(...a.files.map((f) => `${f.sha256}  ./${f.path}`), "```", "");
  }
  return out.join("\n");
}

function renderChecks(list: CheckRecord[]): string {
  const out = ["# 検査の記録", "", "担当の出力を書き換えずに検査した結果。sha256 は検査した時点のもの。", ""];
  for (const c of list) {
    out.push(`## ${c.checkedAt} ${STAGE_NAMES[c.stage]}: ${c.roleName}（${c.definition}）試行 ${c.attempt}（${c.valid ? "合格" : "不合格"}）`, "");
    out.push(`- 担当 ID: ${c.agentId ?? "不明"}`, `- 検査したファイル: \`${c.file}\`（sha256 \`${c.sha256 ?? "無い"}\`）`, `- 親が確かめること: ${c.parent}`, "");
    out.push("| 番号 | 確認 | 結果 |", "|---|---|---|", ...c.items.map((i) => `| ${i.no} | ${cell(i.name)} | ${i.ok ? "合格" : "不合格"} |`), "");
    out.push("### 違反", "", ...(c.violations.length > 0 ? c.violations.map((v) => `- ${v.no}: ${v.message}`) : ["- なし"]), "");
    out.push("### 担当のサブディレクトリの sha256", "", "```text", ...c.files.map((f) => `${f.sha256}  ./${f.path}`), "```", "");
  }
  return out.join("\n");
}

// 役割の最新の試行（隔離済みなら引数の誤り）
function currentAttempt(work: string, role: Role): AgentRecord {
  const last = loadList<AgentRecord>(work, "agents")
    .filter((a) => a.role === role)
    .at(-1);
  if (!last) throw new UsageError(`${ROLES[role].name} の委譲が記録されていません（agent --event start で記録してから）`);
  if (loadList<AttemptRecord>(work, "attempts").some((a) => a.role === role && a.attempt === last.attempt)) {
    throw new UsageError(`${ROLES[role].name} の試行 ${last.attempt} は無効として隔離済みです`);
  }
  return last;
}

function agent(args: string[]): Outcome {
  const o = parseOptions(args, ["work", "role", "event", "agent-id"], []);
  const { work } = loadWork(o);
  const role = roleOf(o.one.get("role"), Object.keys(ROLES) as Role[]);
  const r = ROLES[role];
  const event = o.one.get("event");
  const id = o.one.get("agent-id") ?? null;
  const agents = loadList<AgentRecord>(work, "agents");
  const attempts = loadList<AttemptRecord>(work, "attempts");
  const last = agents.filter((a) => a.role === role).at(-1);
  let record: AgentRecord;
  if (event === "start") {
    const stop = attempts.find((a) => a.failure !== "invalid");
    if (stop) throw new UsageError(`${stop.failureLabel}（${stop.roleName}）で止めたので、どの担当も起動・委譲し直ししません`);
    if (last && !attempts.find((a) => a.role === role && a.attempt === last.attempt)?.redelegate) {
      throw new UsageError(`${r.name} を委譲し直せるのは、retire-attempt が委譲し直してよいと返した試行の後の1回だけです（最新の試行 ${last.attempt}）`);
    }
    // 反証・受け入れ確認は、その担当への入力の写し（refute-input・acceptance-input）が準備完了を返してから
    const copy = STAGE_COPIES[r.stage];
    if (copy) {
      const file = join(work, "parent", `${copy}.json`);
      if (!existsSync(file) || !(JSON.parse(readFileSync(file, "utf8")) as { ready?: boolean }).ready) throw new UsageError(`${copy} が準備完了を返していないので、${r.name}を起動しません`);
    }
    record = { role, roleName: r.name, definition: r.definition, attempt: (last?.attempt ?? 0) + 1, agentId: id, startedAt: now(), receivedAt: null };
    agents.push(record);
  } else if (event === "received") {
    if (!last) throw new UsageError(`${r.name} の委譲の開始が記録されていません`);
    if (last.receivedAt) throw new UsageError(`${r.name} の試行 ${last.attempt} の受領は記録済みです`);
    if (id && last.agentId && id !== last.agentId) throw new UsageError(`担当 ID が委譲の開始の記録（${last.agentId}）と違います: ${id}`);
    last.agentId = id ?? last.agentId;
    last.receivedAt = now();
    record = last;
  } else throw new UsageError("--event は start（委譲の直前）か received（最終返答の受領）にしてください");
  saveList(work, "agents", agents, renderAgents(agents));
  return { work, result: { ...record } };
}

// ---- 探索の引き渡しの機械検査（parent.md 5節。本文への禁止情報の混入と担当の返答は親が確かめる） ----

const STATES = new Set(["充足", "未充足", "未確認", "説明", "自動チェック担当", "受け入れ確認担当", "対象外"]);
const TARGET_FIELDS = ["役割", "定義名", "対象版", "要求資料", "依存の写し", "終了状態"];
const CANDIDATE_FIELDS = ["軸", "場所", "起点", "到達条件", "期待動作", "破綻", "影響", "証拠"];
const TABLE_HEADER = ["要求の出典", "状態", "証拠または不足理由", "候補ID"];
// 禁止項目の名前。コードスパンを除いた見出し・項目名・表の見出しの全体がこれと同じときだけ当てる（`Severity` の表示・buildSummary の呼出元 のような名前の一部には当てない）
const FORBIDDEN = /^(?:暫定の)?(?:重大度|確信度|要約|推論|総合判断|原因の統合|severity|confidence|summary)$/i;
const FENCE = /^\s*(```|~~~)/;
const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
// 箇条書きの項目名（`- 名前: 値`、`**名前**:` も）
const FIELD = /^\s*(?:[-*+]|\d+[.)])\s+(?:\*\*)?([^:：*]{1,40}?)(?:\*\*)?\s*[:：][ \t]*(.*)$/;
const plain = (s: string) => s.replace(/[*`]/g, "").trim();

interface Section {
  title: string;
  body: string[];
}

// 深さ level の見出しごとの節（コードブロックの中の # は見出しにしない）。本文にはより深い見出しを含む
function sectionsOf(lines: string[], level: number): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  let fence = false;
  for (const line of lines) {
    if (FENCE.test(line)) fence = !fence;
    const h = fence ? null : /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    const depth = h?.[1]?.length ?? 7;
    if (h && depth <= level) {
      cur = depth === level ? { title: plain(h[2] ?? ""), body: [] } : null;
      if (cur) out.push(cur);
      continue;
    }
    cur?.body.push(line);
  }
  return out;
}

// 字下げの無い `- 名前: 値` の項目（続く字下げの行は値の続き）。同じ名前は最初のものだけ
function fieldsOf(body: string[]): Map<string, string> {
  const map = new Map<string, string>();
  let key: string | null = null;
  for (const line of body) {
    const m = /^\S/.test(line) ? FIELD.exec(line) : null;
    if (m) {
      const name = plain(m[1] ?? "");
      key = map.has(name) ? null : name;
      if (key) map.set(key, (m[2] ?? "").trim());
    } else if (key && /^\s+\S/.test(line)) map.set(key, `${map.get(key) ?? ""}\n${line.trim()}`.trim());
    else key = null;
  }
  return map;
}

// 表の1行のセル。バッククォートのコードの中と `\|` の | は区切りにしない（コードが閉じていなければ、すべての | で区切る）
function splitRow(line: string): string[] {
  const parse = (code: boolean) => {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    const cells: string[] = [];
    let cur = "";
    let tick = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charAt(i);
      if (ch === "\\" && s.charAt(i + 1) === "|") {
        cur += "|";
        i++;
      } else if (code && ch === "`") {
        let n = 1;
        while (s.charAt(i + n) === "`") n++;
        tick = tick === 0 ? n : tick === n ? 0 : tick;
        cur += "`".repeat(n);
        i += n - 1;
      } else if (ch === "|" && tick === 0) {
        cells.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    cells.push(cur.trim());
    return { cells, closed: tick === 0 };
  };
  const withCode = parse(true);
  return withCode.closed ? withCode.cells : parse(false).cells;
}

// 見出しが header と同じ最初の表の、区切りの行より後の各行のセル。表が無ければ null。
// 見出しのセルは、雛形の名前のあとに括弧の補足が続いてもよい（「判定（要対応／棄却／…）」など）
function tableRows(body: string[], header: string[]): string[][] | null {
  const same = (cells: string[]) =>
    cells.length === header.length &&
    cells.every((c, k) => {
      const got = plain(c).replace(/\s+/g, "");
      const want = header[k] ?? "";
      return got === want || got.startsWith(`${want}（`) || got.startsWith(`${want}(`);
    });
  for (let i = 0; i + 1 < body.length; i++) {
    const line = body[i] ?? "";
    if (!line.trim().startsWith("|") || !SEPARATOR.test(body[i + 1] ?? "") || !same(splitRow(line))) continue;
    const rows: string[][] = [];
    for (let j = i + 2; j < body.length && (body[j] ?? "").trim().startsWith("|"); j++) rows.push(splitRow(body[j] ?? ""));
    return rows;
  }
  return null;
}

// 見出し・項目名・表の見出しの全体が禁止項目の名前か（本文への混入は親が通読して確かめる）
function forbiddenNames(lines: string[]): string[] {
  const hits: string[] = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) {
      fence = !fence;
      return;
    }
    if (fence) return;
    const names: string[] = [];
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) names.push(h[1] ?? "");
    const f = FIELD.exec(line);
    if (f) names.push(f[1] ?? "");
    const b = /^\s*(?:[-*+]\s+)?\*\*([^*]{1,40})\*\*/.exec(line);
    if (b) names.push(b[1] ?? "");
    if (line.trim().startsWith("|") && SEPARATOR.test(lines[i + 1] ?? "")) names.push(...splitRow(line));
    for (const n of names) if (FORBIDDEN.test(plain(n.replace(/`[^`]*`/g, "")))) hits.push(`L${i + 1}「${plain(n)}」`);
  });
  return hits;
}

// text の中に needle がファイル名の続きなしに現れるか（requirements/spec-1.md と requirements/spec-12.md を区別する）
function mentions(text: string, needle: string): boolean {
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) if (!/[\w.-]/.test(text.charAt(i + needle.length))) return true;
  return false;
}

type Add = (no: number, message: string) => void;

// 担当と対象の節（探索は5節の3、反証は7節の2）: 必須の項目、委譲した役割・定義名、target.md と一致する対象版、終了状態
function targetViolations(target: Section | undefined, names: readonly string[], role: Role, prep: Prepared, no: number, add: Add, states = /完了|未確認/): void {
  const r = ROLES[role];
  if (!target) add(no, "「担当と対象」の節が無い");
  const f = fieldsOf(target?.body ?? []);
  for (const name of names) if (!f.get(name)) add(no, `担当と対象の「${name}」が無いか空`);
  const roleValue = plain(f.get("役割") ?? "");
  if (roleValue && roleValue !== r.name) add(no, `役割が委譲した「${r.name}」でない（${roleValue}）`);
  const definition = plain(f.get("定義名") ?? "");
  if (definition && definition !== r.definition) add(no, `定義名が委譲した ${r.definition} でない（${definition}）`);
  const version = f.get("対象版");
  if (version) {
    const shas = (version.match(/\b[0-9a-f]{40}\b/gi) ?? []).map((s) => s.toLowerCase());
    for (const [label, sha] of [
      ["merge-base", prep.mergeBase],
      ["head", prep.head],
    ] as const)
      if (!shas.includes(sha.toLowerCase())) add(no, `対象版に target.md の ${label} ${sha} が無い`);
    const others = [...new Set(shas.filter((s) => s !== prep.head.toLowerCase() && s !== prep.mergeBase.toLowerCase()))];
    if (others.length > 0) add(no, `対象版に target.md と異なる SHA がある（${others.join("・")}）`);
    for (const i of prep.inputs) if (i.path.startsWith("local/") && !version.includes(i.sha256)) add(no, `対象版に ${i.path} の sha256 が無い`);
  }
  const state = f.get("終了状態");
  if (state && !states.test(state)) add(no, `終了状態が雛形の語彙（${states.source.replaceAll("|", "・")}）のどれでもない（${state}）`);
}

function exploreViolations(text: string, role: "standards" | "spec", prep: Prepared, add: Add): void {
  const lines = text.split("\n");
  const secs = sectionsOf(lines, 2);
  const section = (name: string) => secs.find((s) => s.title.startsWith(name));
  const filled = (s: Section | undefined) => s?.body.some((l) => l.trim() !== "") ?? false;

  // 3: 担当と対象、対象版、終了状態・未確認・見送りの節
  targetViolations(section("担当と対象"), TARGET_FIELDS, role, prep, 3, add);
  for (const name of ["探索上の不足・未確認", "判断を見送った事項"]) if (!filled(section(name))) add(3, `「${name}」の節が無いか空`);

  // 4: 候補の必須項目と候補 ID
  const prefix = role === "standards" ? "STD" : "SPC";
  const ids = new Set<string>();
  const candidates = section("候補");
  if (!candidates) add(4, "「候補」の節が無い");
  const blocks = sectionsOf(candidates?.body ?? [], 3);
  if (candidates && blocks.length === 0 && !candidates.body.join("\n").includes("候補0件")) add(4, "候補一覧も「候補0件」の明示も無い");
  for (const b of blocks) {
    const id = /^([A-Za-z]+-\d+)/.exec(b.title)?.[1];
    if (!id) {
      add(4, `候補の見出し「${b.title}」に候補 ID が無い`);
      continue;
    }
    if (ids.has(id)) add(4, `候補 ID ${id} が重複している`);
    ids.add(id);
    if (!id.startsWith(`${prefix}-`)) add(4, `候補 ID ${id} が役割の接頭辞 ${prefix}- を持たない`);
    const cf = fieldsOf(b.body);
    const missing = CANDIDATE_FIELDS.filter((n) => !cf.get(n));
    if (missing.length > 0) add(4, `${id} の必須項目が無いか空（${missing.join("・")}）`);
    const evidence = cf.get("証拠") ?? "";
    if (/取得できな|取得できず/.test(evidence) && !(evidence.includes("理由") && evidence.includes("不足"))) add(4, `${id} は証拠を取得できなかった候補だが、理由と不足箇所が無い`);
  }

  // 5: 役割ごとの節
  if (role === "standards") {
    const rules = section("規約の一覧と適用判断");
    const body = rules?.body ?? [];
    const content = body.filter((l, i) => l.trim() !== "" && !SEPARATOR.test(l) && !(l.trim().startsWith("|") && SEPARATOR.test(body[i + 1] ?? "")));
    if (content.length === 0) add(5, "「規約の一覧と適用判断」の節が無いか、規約の行が無い");
    return forbidden(lines, add);
  }
  if (!filled(section("要求資料の判別"))) add(5, "「要求資料の判別」の節が無いか空");

  // 6: Spec の要求ごとの対応表（列は見出しと各行の出典・状態・候補ID の位置で読む）
  const tableSection = section("要求ごとの対応表");
  const rows = tableRows(tableSection?.body ?? [], TABLE_HEADER);
  if (!rows) add(6, `「要求ごとの対応表」に雛形の4列（${TABLE_HEADER.join("・")}）の表が無い`);
  else {
    if (rows.length === 0) add(6, "要求ごとの対応表に行が無い");
    const sources: string[] = [];
    rows.forEach((cells, i) => {
      if (cells.length < 4) {
        add(6, `対応表の ${i + 1} 行目の列が足りない（出典・状態・候補ID を読み取れない）`);
        return;
      }
      const source = cells[0] ?? "";
      const status = plain(cells[1] ?? "");
      const label = plain(source) || `${i + 1} 行目`;
      sources.push(source);
      if (!STATES.has(status)) add(6, `${label} の状態「${status}」が語彙に無い`);
      const refs = (cells[cells.length - 1] ?? "").match(/[A-Za-z]+-\d+/g) ?? [];
      if ((status === "未充足" || status === "未確認") && refs.length === 0) add(6, `${label} は${status}だが候補 ID が無い`);
      for (const ref of refs) if (!ids.has(ref)) add(6, `${label} が参照する候補 ${ref} が候補一覧に無い`);
    });
    for (const i of prep.inputs) if (i.path.startsWith("requirements/") && !sources.some((s) => mentions(s, i.path))) add(6, `${i.path} が対応表の出典に無い`);
  }
  forbidden(lines, add);
}

// 7: 禁止項目の見出し・項目名
function forbidden(lines: string[], add: (no: number, message: string) => void): void {
  for (const hit of forbiddenNames(lines)) add(7, `禁止項目の見出し・項目名 ${hit}`);
}

function checkExplore(args: string[]): Outcome {
  const o = parseOptions(args, ["work", "role"], []);
  const { work, prep } = loadWork(o);
  const role = roleOf(o.one.get("role"), ["standards", "spec"]) as "standards" | "spec";
  const r = ROLES[role];
  const attempt = currentAttempt(work, role);
  const file = `${role}/${r.output}`;
  const path = join(work, file);
  const violations: Violation[] = [];
  const add = (no: number, message: string) => violations.push({ no, message });
  const body = existsSync(path) && lstatSync(path).isFile() ? readFileSync(path) : null;
  if (body === null) add(2, `${file} が無い`);
  else exploreViolations(body.toString("utf8"), role, prep, add);
  const identity = checkIdentity(work, "explore", `check-explore ${role} 試行 ${attempt.attempt}`);
  for (const i of identity.items) if (!i.ok) add(8, `${i.name}: ${i.detail}`);
  const names: [number, string][] = [
    [2, `指定したパスに ${r.output} がある`],
    [3, "役割・定義名・対象版・要求資料・依存の写し・終了状態と、未確認・見送りの節"],
    [4, "候補の必須項目、候補 ID の接頭辞と重複、証拠を取得できなかった候補の理由と不足箇所"],
    [5, role === "standards" ? "規約の一覧と適用判断" : "要求資料の判別"],
    ...(role === "spec" ? ([[6, "要求ごとの対応表の4列・状態の語彙・候補 ID の参照・requirements/ の全ファイルの出典"]] as [number, string][]) : []),
    [7, "禁止項目の見出し・項目名（本文は親が通読する）"],
    [8, "共通入力・依存の写し・限定 clone の同一性"],
  ];
  const record: CheckRecord = {
    stage: "explore",
    role,
    roleName: r.name,
    definition: r.definition,
    attempt: attempt.attempt,
    agentId: attempt.agentId,
    file,
    sha256: body === null ? null : sha256(body),
    valid: violations.length === 0,
    items: names.map(([no, name]) => ({ no, name, ok: !violations.some((v) => v.no === no) })),
    violations,
    identity,
    files: fingerprintList(join(work, role)),
    parent: "1（担当の返答が入力不備・失敗でない）と、7の禁止項目の本文への混入（引き渡し本文の通読）",
    checkedAt: now(),
  };
  const list = [...loadList<CheckRecord>(work, "checks"), record];
  saveList(work, "checks", list, renderChecks(list));
  return { work, result: { ...record } };
}

// ---- 無効な試行の隔離と再委譲の可否（parent.md 4.1節。失敗の分類と委譲は親） ----

function retireAttempt(args: string[]): Outcome {
  const o = parseOptions(args, ["work", "role", "failure", "reason", "retries"], []);
  const { work } = loadWork(o);
  const role = roleOf(o.one.get("role"), Object.keys(ROLES) as Role[]);
  const r = ROLES[role];
  const failure = o.one.get("failure") ?? "";
  if (!Object.hasOwn(FAILURES, failure)) {
    throw new UsageError(`--failure は ${Object.entries(FAILURES).map(([k, v]) => `${k}（${v}）`).join("・")} のどれかにしてください: ${failure || "なし"}`);
  }
  const kind = failure as Failure;
  const reason = o.one.get("reason")?.trim();
  if (!reason) throw new UsageError("--reason に無効の理由（検査の番号と違反の箇所、または終了通知の状態とエラーの文言）を書いてください");
  const retries = o.one.get("retries")?.trim() || "記録なし";
  const attempt = currentAttempt(work, role);
  const from = join(work, role);
  const movedTo = join(work, "parent/attempts", `${role}-${attempt.attempt}`);
  if (existsSync(movedTo)) throw new UsageError(`隔離先が既にあります: ${movedTo}`);
  mkdirSync(dirname(movedTo), { recursive: true });
  if (existsSync(from)) renameSync(from, movedTo);
  else mkdirSync(movedTo);
  mkdirSync(join(from, "notes"), { recursive: true });
  const identity = checkIdentity(work, r.stage, `retire-attempt ${role} 試行 ${attempt.attempt}`);
  const attempts = loadList<AttemptRecord>(work, "attempts");
  const stop = attempts.find((a) => a.failure !== "invalid");
  let finalReason: string | null = null;
  if (kind === "usage-limit") finalReason = `利用枠の上限、有効な結果なし（${r.name}）`;
  else if (kind === "aborted") finalReason = "利用者による中止";
  else if (stop) finalReason = stop.finalReason;
  else if (attempt.attempt >= 2) finalReason = `有効な結果なし（${r.name}。1回の再委譲の後も）`;
  else if (!identity.ok) finalReason = `有効な結果なし（${r.name}。同じ入力を固定できず委譲し直さなかった）`;
  const record: AttemptRecord = {
    role,
    roleName: r.name,
    definition: r.definition,
    attempt: attempt.attempt,
    agentId: attempt.agentId,
    failure: kind,
    failureLabel: FAILURES[kind],
    reason,
    retries,
    movedTo,
    files: fingerprintList(movedTo),
    identity,
    redelegate: finalReason === null,
    status: finalReason === null ? null : "未完了",
    finalReason,
    retiredAt: now(),
  };
  attempts.push(record);
  saveList(work, "attempts", attempts, renderAttempts(attempts));
  const notRun = finalReason === null ? {} : { score: NOT_RUN_SCORE, merge: NOT_RUN_MERGE };
  return { work, result: { ...record, ...notRun } };
}

// ---- 反証への入力（parent.md 6節） ----

function refuteInput(args: string[]): Outcome {
  const o = parseOptions(args, ["work"], []);
  const { work, prep } = loadWork(o);
  const agents = loadList<AgentRecord>(work, "agents");
  const checks = loadList<CheckRecord>(work, "checks");
  const attempts = loadList<AttemptRecord>(work, "attempts");
  const passed: { role: "standards" | "spec"; check: CheckRecord }[] = [];
  const missing: string[] = [];
  for (const role of ["standards", "spec"] as const) {
    const last = agents.filter((a) => a.role === role).at(-1);
    const check = last && checks.filter((c) => c.stage === "explore" && c.role === role && c.attempt === last.attempt).at(-1);
    const retired = last && attempts.some((a) => a.role === role && a.attempt === last.attempt);
    if (last && check?.valid && !retired) passed.push({ role, check });
    else missing.push(`${ROLES[role].name}: ${!last ? "委譲の記録が無い" : retired ? `試行 ${last.attempt} は無効として隔離済み` : !check ? `試行 ${last.attempt} を検査していない` : `試行 ${last.attempt} の検査が不合格`}`);
  }
  if (missing.length > 0) throw new UsageError(`両探索の合格した引き渡しがそろっていないので写しません（${missing.join("・")}）`);
  const dest = join(work, "refute-input");
  if (existsSync(dest) && readdirSync(dest).length > 0) throw new UsageError(`refute-input/ が空ではありません（写し直しません）: ${dest}`);
  mkdirSync(dest, { recursive: true });
  for (const { role } of passed) {
    const src = join(work, role, "handoff.md");
    if (existsSync(src)) copyFileSync(src, join(dest, `${role}-handoff.md`));
  }
  for (const name of ["target.md", "manifest.md", "requirements", "local", "deps-files.sha256"]) {
    const src = join(work, "input", name);
    if (existsSync(src)) copyTree(src, join(dest, name));
  }
  const expected = [
    ...passed.map((p) => ({ path: `${p.role}-handoff.md`, sha256: p.check.sha256 ?? "", source: `${p.role}/handoff.md（check-explore で検査した試行 ${p.check.attempt}）` })),
    ...prep.inputs.map((i) => ({ ...i, source: `input/${i.path}（prepare の記録）` })),
    { path: "manifest.md", sha256: prep.manifestSha256 ?? "", source: "input/manifest.md（prepare の記録）" },
  ];
  const files = fingerprintList(dest);
  const got = new Map(files.map((f) => [f.path, f.sha256]));
  const comparison = [
    ...expected.map((e) => ({ ...e, copied: got.get(e.path) ?? null, ok: got.get(e.path) === e.sha256 })),
    ...files.filter((f) => !expected.some((e) => e.path === f.path)).map((f) => ({ path: f.path, sha256: "", source: "写すものではない", copied: f.sha256, ok: false })),
  ];
  const identity = checkIdentity(work, "explore", "refute-input");
  const ready = comparison.every((c) => c.ok) && identity.ok;
  const md = [
    "# 反証への入力の指紋",
    "",
    `- 写した時刻: ${now()}`,
    `- 結果: ${ready ? "一致（反証を起動してよい）" : `不一致（反証を起動しない。未完了（理由: ${REFUTE_UNFIXED}））`}`,
    "",
    "| ファイル | 写しの sha256 | 照合先 | 照合先の sha256 | 一致 |",
    "|---|---|---|---|---|",
    ...comparison.map((c) => `| \`${c.path}\` | \`${c.copied ?? "無い"}\` | ${cell(c.source)} | \`${c.sha256 || "なし"}\` | ${c.ok ? "一致" : "不一致"} |`),
    "",
    "## refute-input/ の各ファイルの sha256",
    "",
    "```text",
    fileFingerprint(dest).trimEnd(),
    "```",
    "",
    "## 同一性の確認（共通入力・依存の写し・限定 clone）",
    "",
    ...identity.items.map((i) => `- ${i.name}: ${i.ok ? "一致" : "不一致"}（${i.detail}）`),
    "",
  ];
  writeFileSync(join(work, "parent/fingerprints.md"), md.join("\n"));
  const outcome = ready ? { status: "準備完了", reason: null } : { status: "未完了", reason: REFUTE_UNFIXED, score: NOT_RUN_SCORE, merge: NOT_RUN_MERGE };
  return { work, result: { ready, ...outcome, files, comparison, identity } };
}

// ---- 反証の判定本文の機械検査（parent.md 7節。親は判定本文を通読しない） ----

const VERDICTS = new Set(["要対応", "棄却", "未確認", "基点から存在（対象外）", "任意"]);
const AXES = ["Standards", "Spec"] as const;
type Axis = (typeof AXES)[number];
const REFUTE_TARGET_FIELDS = ["役割", "定義名", "対象版", "受け取った入力", "依存の写し", "終了状態"];
const DECISION_HEADER = ["候補ID", "発見者の区分", "判定", "影響度", "同一原因", "根拠"];
const SPLIT_HEADER = ["要求の出典", "分割元の出典"];
const UNCONFIRMED_HEADER = ["要求の出典または候補ID", "軸", "種別", "理由", "確かめる担当", "不足箇所"];
const UNCONFIRMED_KINDS = new Set(["候補", "要求", "要求間の矛盾"]);
const ACCEPTANCE_HEADER = ["要求の出典", "確かめること（成果物）", "確かめること（作業・手順・配置）", "必要な外部の正本"];
const ACCEPTANCE_STATE = "受け入れ確認担当";
const NO_FINDING = "反証で追加した発見なし";
const IMPACT = /^([0-4])(?!\d)/;
// 節の「なし」の明示（行頭の「なし」。表のセルの「なし（追加）」は表の行として読む）
const NONE = /^(?:[-*+]\s*)?なし(?:$|[\s。.、（(])/;
// 要求の出典を比べる形（バッククォートと * を外して空白をまとめる）。parent/refute-structure.json の出典もこの形で残す
const norm = (s: string) => plain(s).replace(/\s+/g, " ");
// セルの候補 ID（CAUSE-<n> は同一原因の印で、候補 ID ではない）
const candidateIds = (s: string) => (s.match(/\b[A-Za-z]+-\d+\b/g) ?? []).filter((x) => !x.startsWith("CAUSE-"));

// 採否一覧の1行
export interface Decision {
  id: string;
  finder: string;
  verdict: string;
  // 要対応の影響度 0〜4（要対応以外は null）
  impact: number | null;
  cause: string | null;
  reason: string;
}

// 要対応の節の1件（同一原因は1件。ids は含まれる候補 ID。location と effect は報告へ短く転記する場所と影響）
export interface RequiredItem {
  heading: string;
  title: string;
  ids: string[];
  impact: number | null;
  axis: Axis | null;
  location: string;
  effect: string;
}

// 要求ごとの対応表（確定）の1行。splitFrom は分割元の Spec 探索の行の出典、added は反証が足した行
export interface TableRow {
  source: string;
  status: string;
  evidence: string;
  candidates: string[];
  splitFrom: string | null;
  added: boolean;
}

// 未確認と理由の表の1行（ref は要求の出典または候補 ID、kind は 候補・要求・要求間の矛盾）
export interface UnconfirmedRow {
  ref: string;
  axis: string;
  kind: string;
  reason: string;
  owner: string;
  missing: string;
}

// 受け入れ確認担当の行の節の1行（candidates は対応表の同じ行の候補 ID、line は判定本文の行番号）
export interface AcceptanceRow {
  source: string;
  artifacts: string;
  work: string;
  canon: string;
  candidates: string[];
  line: number;
}

interface RefuteParsed {
  axes: Record<Axis, { required: number; unconfirmed: number }>;
  decisions: Decision[];
  required: RequiredItem[];
  table: TableRow[];
  unconfirmed: UnconfirmedRow[];
  acceptanceRows: AcceptanceRow[];
}

// check-refute に合格した判定本文から読み取った構造（parent/refute-structure.json）。点数・確認が残る事項の算出はこれを読む
export interface RefuteStructure extends RefuteParsed {
  attempt: number;
  agentId: string | null;
  file: string;
  sha256: string;
  checkedAt: string;
  acceptanceRequired: boolean;
}

// 節の中の雛形の表。表の行が無ければ、節に「なし」の明示があるか
function sectionTable(sec: Section | undefined, header: string[]): { rows: string[][]; none: boolean } {
  return { rows: tableRows(sec?.body ?? [], header) ?? [], none: (sec?.body ?? []).some((l) => NONE.test(plain(l))) };
}

// 探索の引き渡しの候補 ID と、Spec 探索の対応表の要求の出典
function handoffCandidates(text: string): string[] {
  const candidates = sectionsOf(text.split("\n"), 2).find((s) => s.title.startsWith("候補"));
  return sectionsOf(candidates?.body ?? [], 3).flatMap((b) => /^([A-Za-z]+-\d+)/.exec(b.title)?.[1] ?? []);
}

function handoffSources(text: string): string[] {
  const table = sectionsOf(text.split("\n"), 2).find((s) => s.title.startsWith("要求ごとの対応表"));
  return (tableRows(table?.body ?? [], TABLE_HEADER) ?? []).map((c) => norm(c[0] ?? ""));
}

function refuteViolations(text: string, prep: Prepared, handoffs: { standards: string; spec: string }, add: Add): RefuteParsed {
  const lines = text.split("\n");
  const secs = sectionsOf(lines, 2);
  const section = (name: string) => secs.find((s) => s.title.startsWith(name));
  // 判定本文が挙げる候補 ID（反証で追加した REF-<n> が採否一覧にあるかを確かめる）
  const mentioned: string[] = [];

  // 2: 担当と対象
  targetViolations(section("担当と対象"), REFUTE_TARGET_FIELDS, "refute", prep, 2, add);

  // 3: 採否一覧（両探索の全候補と反証で追加した発見、判定の語彙と根拠、要対応の影響度）
  const expected = [...new Set([...handoffCandidates(handoffs.standards), ...handoffCandidates(handoffs.spec)])];
  const decisions: Decision[] = [];
  const decisionRows = tableRows(section("採否一覧")?.body ?? [], DECISION_HEADER);
  if (!decisionRows) add(3, `「採否一覧」に雛形の6列（${DECISION_HEADER.join("・")}）の表が無い`);
  (decisionRows ?? []).forEach((cells, i) => {
    if (cells.length < DECISION_HEADER.length) return add(3, `採否一覧の ${i + 1} 行目の列が足りない`);
    const id = /^([A-Za-z]+-\d+)$/.exec(plain(cells[0] ?? ""))?.[1];
    if (!id) return add(3, `採否一覧の ${i + 1} 行目に候補 ID が1つだけ書かれていない（${plain(cells[0] ?? "")}）`);
    const verdict = plain(cells[2] ?? "");
    const impactCell = plain(cells[3] ?? "");
    const impact = IMPACT.exec(impactCell)?.[1];
    const reason = plain(cells[5] ?? "");
    if (decisions.some((d) => d.id === id)) add(3, `採否一覧に ${id} が重複している`);
    if (!expected.includes(id) && !id.startsWith("REF-")) add(3, `採否一覧の ${id} が両探索の候補にも反証で追加した発見（REF-<n>）にも無い`);
    if (!VERDICTS.has(verdict)) add(3, `${id} の判定「${verdict}」が語彙に無い`);
    if (verdict === "要対応" && impact === undefined) add(3, `${id} は要対応だが影響度 0〜4 が無い（${impactCell || "空"}）`);
    if (verdict !== "要対応" && /\d/.test(impactCell)) add(3, `${id} は要対応ではないが影響度がある（${impactCell}）`);
    if (!reason) add(3, `${id} の根拠が無い`);
    decisions.push({ id, finder: plain(cells[1] ?? ""), verdict, impact: verdict === "要対応" && impact !== undefined ? Number(impact) : null, cause: /CAUSE-\d+/.exec(cells[4] ?? "")?.[0] ?? null, reason });
  });
  const decided = new Map(decisions.map((d) => [d.id, d]));
  for (const id of expected) if (!decided.has(id)) add(3, `両探索の候補 ${id} が採否一覧に無い`);

  // 3: 要対応の節と採否一覧の一致（同一候補の判定、同一原因の集約と影響度）
  const requiredSection = section("要対応");
  const blocks = sectionsOf(requiredSection?.body ?? [], 3);
  if (!requiredSection) add(3, "「要対応」の節が無い");
  else if (blocks.length === 0 && !requiredSection.body.some((l) => NONE.test(plain(l)))) add(3, "要対応の見出しも「なし」の明示も無い");
  const required: RequiredItem[] = [];
  const placed = new Map<string, string>();
  for (const b of blocks) {
    const m = /^((?:CAUSE|[A-Za-z]+)-\d+)\s*[:：]?\s*(.*)$/.exec(b.title);
    const heading = m?.[1];
    if (!heading) {
      add(3, `要対応の見出し「${b.title}」に CAUSE-<n> か候補 ID が無い`);
      continue;
    }
    const f = fieldsOf(b.body);
    const ids = candidateIds(f.get("候補 ID と発見者の区分") ?? "");
    mentioned.push(...ids);
    const impact = IMPACT.exec(plain(f.get("影響度") ?? ""))?.[1];
    const axis = AXES.find((a) => plain(f.get("軸") ?? "").startsWith(a)) ?? null;
    const cause = heading.startsWith("CAUSE-");
    if (ids.length === 0) add(3, `要対応 ${heading} に候補 ID が無い`);
    if (impact === undefined) add(3, `要対応 ${heading} に影響度 0〜4 が無い`);
    if (!axis) add(5, `要対応 ${heading} の軸が Standards／Spec のどちらでもない`);
    if (!cause && !ids.includes(heading)) add(3, `要対応 ${heading} の候補 ID の欄に見出しの ${heading} が無い`);
    for (const id of ids) {
      const d = decided.get(id);
      if (!d) add(3, `要対応 ${heading} の ${id} が採否一覧に無い`);
      else if (d.verdict !== "要対応" && !(cause && d.cause === heading)) add(3, `${id} は要対応 ${heading} にあるが、採否一覧の判定は「${d.verdict}」（同一候補の判定の不一致）`);
      if (placed.has(id)) add(3, `${id} が要対応の ${placed.get(id)} と ${heading} の両方にある`);
      else placed.set(id, heading);
    }
    const impacts = ids.flatMap((id) => decided.get(id)?.impact ?? []);
    if (impact !== undefined && impacts.length > 0 && Number(impact) !== Math.min(...impacts)) {
      add(3, `要対応 ${heading} の影響度 ${impact} が、採否一覧の影響度の最小値 ${Math.min(...impacts)} と違う`);
    }
    required.push({ heading, title: plain(m?.[2] ?? ""), ids, impact: impact === undefined ? null : Number(impact), axis, location: norm(f.get("場所") ?? ""), effect: norm(f.get("影響") ?? "") });
  }
  for (const d of decisions.filter((x) => x.verdict === "要対応")) {
    const at = placed.get(d.id);
    if (!at) add(3, `採否一覧で要対応の ${d.id} が要対応の節に無い`);
    else if (d.cause && at !== d.cause) add(3, `${d.id} は採否一覧で同一原因 ${d.cause} だが、要対応の節では ${at} にある`);
    else if (!d.cause && at.startsWith("CAUSE-")) add(3, `${d.id} は要対応の節で ${at} にあるが、採否一覧に同一原因が無い`);
  }

  // 4: 要求ごとの対応表（確定）と、分割・追加した行の分割元の出典、Spec 探索の対応表の全行の確定
  const rows = tableRows(section("要求ごとの対応表")?.body ?? [], TABLE_HEADER);
  const table: TableRow[] = [];
  if (!rows) add(4, `「要求ごとの対応表（確定）」に雛形の4列（${TABLE_HEADER.join("・")}）の表が無い`);
  else if (rows.length === 0) add(4, "要求ごとの対応表に行が無い");
  (rows ?? []).forEach((cells, i) => {
    if (cells.length < 4) return add(4, `対応表の ${i + 1} 行目の列が足りない（出典・状態・候補ID を読み取れない）`);
    const source = norm(cells[0] ?? "");
    const status = plain(cells[1] ?? "");
    const label = source || `${i + 1} 行目`;
    const ids = candidateIds(cells[cells.length - 1] ?? "");
    mentioned.push(...ids);
    if (table.some((t) => t.source === source)) add(4, `対応表の要求の出典 ${label} が重複している`);
    if (!STATES.has(status)) add(4, `${label} の状態「${status}」が語彙に無い`);
    if (status === "未充足" && !ids.some((id) => decided.get(id)?.verdict === "要対応")) add(4, `${label} は未充足だが、採否一覧で要対応の候補 ID が無い`);
    for (const id of ids) if (!decided.has(id)) add(4, `${label} が参照する候補 ${id} が採否一覧に無い`);
    table.push({ source, status, evidence: norm(cells.slice(2, -1).join(" | ")), candidates: ids, splitFrom: null, added: false });
  });
  const specSources = handoffSources(handoffs.spec);
  const tableSources = new Set(table.map((t) => t.source));
  const splitSection = section("分割・追加した行");
  const split = sectionTable(splitSection, SPLIT_HEADER);
  if (!splitSection) add(4, "「分割・追加した行」の節が無い");
  else if (split.rows.length === 0 && !split.none) add(4, `「分割・追加した行」に雛形の2列（${SPLIT_HEADER.join("・")}）の表も「なし」の明示も無い`);
  const origins = new Map<string, string | null>();
  split.rows.forEach((cells, i) => {
    if (cells.length < 2) return add(4, `分割・追加した行の ${i + 1} 行目の列が足りない`);
    const source = norm(cells[0] ?? "");
    const origin = norm(cells[1] ?? "");
    if (!tableSources.has(source)) add(4, `分割・追加した行の ${source} が対応表に無い`);
    if (origins.has(source)) add(4, `分割・追加した行に ${source} が重複している`);
    if (origin.startsWith("なし")) return origins.set(source, null);
    if (!specSources.includes(origin)) add(4, `${source} の分割元の出典 ${origin || "（空）"} が Spec 探索の対応表の行に無い`);
    origins.set(source, origin);
  });
  for (const t of table) {
    if (origins.has(t.source)) {
      t.splitFrom = origins.get(t.source) ?? null;
      t.added = t.splitFrom === null;
    } else if (!specSources.includes(t.source)) add(4, `対応表の ${t.source} が Spec 探索の対応表の行と同じ出典でなく、分割・追加した行にも無い（分割元の出典の欠落）`);
  }
  const covered = new Set([...tableSources, ...[...origins.values()].filter((o): o is string => o !== null)]);
  for (const s of specSources) if (!covered.has(s)) add(4, `Spec 探索の対応表の行 ${s} を確定していない（対応表にも分割元の出典にも無い）`);

  // 5: 未確認と理由の表（自由記述でなく、出典または候補 ID・軸・種別・理由・確かめる担当・不足箇所）
  const bySource = new Map(table.map((t) => [t.source, t]));
  const unconfirmedSection = section("未確認と理由");
  const un = sectionTable(unconfirmedSection, UNCONFIRMED_HEADER);
  if (!unconfirmedSection) add(5, "「未確認と理由」の節が無い");
  else if (un.rows.length === 0 && !un.none) add(5, `「未確認と理由」に雛形の6列（${UNCONFIRMED_HEADER.join("・")}）の表も「なし」の明示も無い`);
  const unconfirmed: UnconfirmedRow[] = [];
  un.rows.forEach((raw, i) => {
    if (raw.length < UNCONFIRMED_HEADER.length) return add(5, `未確認と理由の ${i + 1} 行目の列が足りない`);
    const c = raw.map(norm);
    const row: UnconfirmedRow = { ref: c[0] ?? "", axis: c[1] ?? "", kind: c[2] ?? "", reason: c[3] ?? "", owner: c[4] ?? "", missing: c[5] ?? "" };
    const label = row.ref || `${i + 1} 行目`;
    if (!AXES.some((a) => a === row.axis)) add(5, `未確認の ${label} の軸「${row.axis}」が Standards／Spec のどちらでもない`);
    if (!UNCONFIRMED_KINDS.has(row.kind)) add(5, `未確認の ${label} の種別「${row.kind}」が語彙（候補・要求・要求間の矛盾）に無い`);
    const empty = (
      [
        ["理由", row.reason],
        ["確かめる担当", row.owner],
        ["不足箇所", row.missing],
      ] as const
    ).flatMap(([name, value]) => (value ? [] : [name]));
    if (empty.length > 0) add(5, `未確認の ${label} の ${empty.join("・")} が空`);
    if (row.kind === "候補") {
      const id = /^([A-Za-z]+-\d+)$/.exec(row.ref)?.[1];
      const d = id ? decided.get(id) : undefined;
      if (id) mentioned.push(id);
      if (!id) add(5, `未確認の ${label} は種別が候補だが、候補 ID が1つだけ書かれていない`);
      else if (!d) add(5, `未確認の ${id} が採否一覧に無い`);
      else if (d.verdict !== "未確認") add(5, `${id} は未確認と理由の表にあるが、採否一覧の判定は「${d.verdict}」（同一候補の判定の不一致）`);
    } else if (UNCONFIRMED_KINDS.has(row.kind)) {
      const t = bySource.get(row.ref);
      if (!t) add(5, `未確認の ${label} が対応表の要求の出典に無い`);
      else if (t.status !== "未確認") add(5, `未確認の ${label} は対応表の状態が「${t.status}」（未確認ではない）`);
    }
    unconfirmed.push(row);
  });
  for (const d of decisions) if (d.verdict === "未確認" && !unconfirmed.some((u) => u.kind === "候補" && u.ref === d.id)) add(5, `採否一覧で未確認の ${d.id} が未確認と理由の表に無い`);
  for (const t of table) if (t.status === "未確認" && !unconfirmed.some((u) => u.kind !== "候補" && u.ref === t.source)) add(5, `対応表で未確認の ${t.source} が未確認と理由の表に無い`);

  // 5: 軸ごとの要対応と未確認の件数（要対応の節の軸ごとの件数、未確認と理由の表の軸ごとの行数と一致）
  const axisFields = fieldsOf(section("軸ごとの結果")?.body ?? []);
  const count = (a: Axis) => ({ required: required.filter((r) => r.axis === a).length, unconfirmed: unconfirmed.filter((u) => u.axis === a).length });
  const axes = { Standards: count("Standards"), Spec: count("Spec") };
  for (const a of AXES) {
    const m = /要対応\s*(\d+)\s*件[\s\S]*?未確認\s*(\d+)\s*件/.exec(axisFields.get(a) ?? "");
    if (!m) {
      add(5, `軸ごとの結果の ${a} に「要対応 N 件、未確認 M 件」が無い`);
      continue;
    }
    const counted = axes[a];
    axes[a] = { required: Number(m[1]), unconfirmed: Number(m[2]) };
    if (axes[a].required !== counted.required) add(5, `軸ごとの結果の ${a} の要対応 ${m[1]} 件が、要対応の節の軸 ${a} の ${counted.required} 件と違う`);
    if (axes[a].unconfirmed !== counted.unconfirmed) add(5, `軸ごとの結果の ${a} の未確認 ${m[2]} 件が、未確認と理由の表の軸 ${a} の ${counted.unconfirmed} 件と違う`);
  }
  // 5: 反証で追加した発見（採否一覧にあるか、無いことの明示）と、判断を見送った事項
  for (const id of new Set(mentioned.filter((x) => x.startsWith("REF-")))) if (!decided.has(id)) add(3, `反証で追加した ${id} が採否一覧に無い`);
  if (!decisions.some((d) => d.id.startsWith("REF-")) && !text.includes(NO_FINDING)) add(5, `反証で追加した発見（REF-<n>）も「${NO_FINDING}」の明示も無い`);
  if (!section("判断を見送った事項")?.body.some((l) => l.trim() !== "")) add(5, "「判断を見送った事項」の節が無いか空");

  // 6: 受け入れ確認担当の行の節（対応表で状態が「受け入れ確認担当」の行と同じ要求の出典、確かめることと必要な外部の正本）
  const acceptanceSection = section("受け入れ確認担当の行");
  const acc = sectionTable(acceptanceSection, ACCEPTANCE_HEADER);
  if (!acceptanceSection) add(6, "「受け入れ確認担当の行」の節が無い");
  else if (acc.rows.length === 0 && !acc.none) add(6, `「受け入れ確認担当の行」に雛形の4列（${ACCEPTANCE_HEADER.join("・")}）の表も「なし」の明示も無い`);
  const headingLine = lines.findIndex((l) => /^##\s+受け入れ確認担当の行/.test(l));
  const acceptanceRows: AcceptanceRow[] = [];
  acc.rows.forEach((raw, i) => {
    if (raw.length < ACCEPTANCE_HEADER.length) return add(6, `受け入れ確認担当の行の ${i + 1} 行目の列が足りない`);
    const [source = "", artifacts = "", work = "", canon = ""] = raw.map(norm);
    const label = source || `${i + 1} 行目`;
    const empty = ACCEPTANCE_HEADER.slice(1).filter((_, k) => ![artifacts, work, canon][k]);
    if (empty.length > 0) add(6, `受け入れ確認担当の行 ${label} の ${empty.join("・")} が空（要らなければ「なし」と書く）`);
    const t = bySource.get(source);
    if (t?.status !== ACCEPTANCE_STATE) add(6, `受け入れ確認担当の行 ${label} が、対応表で状態が「受け入れ確認担当」の行に無い`);
    if (acceptanceRows.some((r) => r.source === source)) add(6, `受け入れ確認担当の行 ${label} が重複している`);
    const line = lines.findIndex((l, k) => k > headingLine && l.trim().startsWith("|") && norm(splitRow(l)[0] ?? "") === source) + 1;
    acceptanceRows.push({ source, artifacts, work, canon, candidates: t?.candidates ?? [], line });
  });
  for (const t of table) if (t.status === ACCEPTANCE_STATE && !acceptanceRows.some((r) => r.source === t.source)) add(6, `対応表の受け入れ確認担当の行 ${t.source} が受け入れ確認担当の行の節に無い`);

  return { axes, decisions, required, table, unconfirmed, acceptanceRows };
}

function renderRows(s: RefuteStructure): string {
  const n = s.acceptanceRows.length;
  return [
    "# 受け入れ確認担当の行",
    "",
    `- 反証の判定本文: \`${s.file}\`（試行 ${s.attempt}、担当 ID ${s.agentId ?? "不明"}、sha256 \`${s.sha256}\`。check-refute に合格）`,
    `- 件数: ${n}`,
    `- 受け入れ確認担当: ${n > 0 ? `必要な担当（${n} 行。有効な結果を受け取るまで完了にしない）` : "受け入れ確認担当の行なし（起動せず）"}`,
    "",
    ...(n > 0
      ? [
          "| 要求の出典 | 確かめること（成果物） | 確かめること（作業・手順・配置） | 必要な外部の正本 | 候補ID |",
          "|---|---|---|---|---|",
          ...s.acceptanceRows.map((r) => `| ${cell(r.source)} | ${cell(r.artifacts)} | ${cell(r.work)} | ${cell(r.canon)} | ${r.candidates.join("・") || "なし"} |`),
          "",
        ]
      : []),
  ].join("\n");
}

function checkRefute(args: string[]): Outcome {
  const o = parseOptions(args, ["work"], []);
  const { work, prep } = loadWork(o);
  if (existsSync(join(work, "parent/acceptance/records.json"))) throw new UsageError("受け入れ確認への写しを取った後は、反証の結果を検査し直しません");
  const r = ROLES.refute;
  const attempt = currentAttempt(work, "refute");
  const file = `refute/${r.output}`;
  const path = join(work, file);
  const violations: Violation[] = [];
  const add: Add = (no, message) => violations.push({ no, message });
  const body = existsSync(path) && lstatSync(path).isFile() ? readFileSync(path) : null;
  const handoff = (role: "standards" | "spec") => {
    const f = join(work, "refute-input", `${role}-handoff.md`);
    return existsSync(f) ? readFileSync(f, "utf8") : "";
  };
  const parsed = body === null ? null : refuteViolations(body.toString("utf8"), prep, { standards: handoff("standards"), spec: handoff("spec") }, add);
  if (body === null) add(1, `${file} が無い`);
  const identity = checkIdentity(work, "refute", `check-refute 試行 ${attempt.attempt}`);
  for (const i of identity.items) if (!i.ok) add(7, `${i.name}: ${i.detail}`);
  const names: [number, string][] = [
    [1, `指定したパスに ${r.output} がある`],
    [2, "役割・定義名・対象版・受け取った入力・依存の写し・終了状態"],
    [3, "採否一覧に両探索の全候補 ID と反証で追加した発見、判定の語彙と根拠、要対応の影響度 0〜4、要対応の節と採否一覧（同一候補の判定・同一原因の集約と影響度）の一致"],
    [4, "要求ごとの対応表の4列・状態の語彙・候補 ID の参照、分割・追加した行の分割元の出典、Spec 探索の対応表の全行の確定"],
    [5, "反証で追加した発見の明示、軸ごとの要対応と未確認の件数と個別の判定の一致、未確認と理由の表、判断を見送った事項"],
    [6, "受け入れ確認担当の行の節と対応表の受け入れ確認担当の行の一致、確かめることと必要な外部の正本"],
    [7, "refute-input/ の写し・共通入力・依存の写し・限定 clone の同一性"],
  ];
  const checkedAt = now();
  const record: CheckRecord = {
    stage: "refute",
    role: "refute",
    roleName: r.name,
    definition: r.definition,
    attempt: attempt.attempt,
    agentId: attempt.agentId,
    file,
    sha256: body === null ? null : sha256(body),
    valid: violations.length === 0,
    items: names.map(([no, name]) => ({ no, name, ok: !violations.some((v) => v.no === no) })),
    violations,
    identity,
    files: fingerprintList(join(work, "refute")),
    parent: "1（担当の返答が入力不備・失敗でない）。判定本文は通読しない",
    checkedAt,
  };
  const list = [...loadList<CheckRecord>(work, "checks"), record];
  saveList(work, "checks", list, renderChecks(list));
  // 構造と担当行は、合格した最新の判定本文からだけ残す
  const structureFile = join(work, "parent/refute-structure.json");
  const rowsFile = join(work, "parent/acceptance/rows.md");
  rmSync(structureFile, { force: true });
  rmSync(rowsFile, { force: true });
  if (!record.valid || !parsed || body === null) return { work, result: { ...record, acceptanceRows: null, acceptanceRequired: null, structure: null } };
  const structure: RefuteStructure = { attempt: attempt.attempt, agentId: attempt.agentId, file, sha256: sha256(body), checkedAt, ...parsed, acceptanceRequired: parsed.acceptanceRows.length > 0 };
  writeFileSync(structureFile, `${JSON.stringify(structure, null, 2)}\n`);
  mkdirSync(dirname(rowsFile), { recursive: true });
  writeFileSync(rowsFile, renderRows(structure));
  const result = { ...record, acceptanceRows: structure.acceptanceRows.length, acceptanceRequired: structure.acceptanceRequired, structure: "parent/refute-structure.json", rows: "parent/acceptance/rows.md" };
  return { work, result };
}

// ---- 受け入れ確認への入力（parent.md 8節。写す参照の抽出は親、写し・取得・目録はスクリプト） ----

const CI_LOG = "[ci-result]";
const CI_BEGIN = "<!-- ci-result:begin -->";
const CI_END = "<!-- ci-result:end -->";
const CI_REMOVED = "（CI の結果は親だけが扱うため除いた）";
// レビューの作業ディレクトリと常設データセット（copy-evidence.ts と同じ。Git のリポジトリにも当てる）
const FORBIDDEN_AREAS = [".local/share/nod/code-reviews", ".local/share/nod/review-evaluation"];
const REF_TYPES = ["file", "git", "document", "url"] as const;
type RefType = (typeof REF_TYPES)[number];
const REF_KINDS = ["参照された記録", "外部の正本", "明示された証拠"] as const;
type RefKind = (typeof REF_KINDS)[number];
const DOC_REF = /^(?:document[:\s]*|Document\s*)?#?(\d+)$/i;
const SECRET_QUERY = /token|key|secret|password|signature|sig|credential|x-amz-/i;
const UNCHECKED = "親は確かめていない（出典の場所が示すのは取得時刻の内容）";

type Replaced = "本文全体" | "印の間" | null;

// parent.md 8.1 の CI の結果の除去: 本文が [ci-result] で始まれば本文全体を、印の行の間だけを置き換え、印が無ければそのまま
function ciStrip(data: Buffer): { data: Buffer; replaced: Replaced } {
  if (data.subarray(0, CI_LOG.length).toString("latin1") === CI_LOG) return { data: Buffer.from(`${CI_REMOVED}\n`), replaced: "本文全体" };
  const lines = data.toString("latin1").split("\n");
  if (!lines.includes(CI_BEGIN)) return { data, replaced: null };
  if (lines.at(-1) === "") lines.pop();
  const out: Buffer[] = [];
  let skip = false;
  for (const line of lines) {
    if (line === CI_BEGIN) {
      out.push(Buffer.from(`${line}\n`, "latin1"), Buffer.from(`${CI_REMOVED}\n`));
      skip = true;
      continue;
    }
    if (line === CI_END) skip = false;
    if (!skip) out.push(Buffer.from(`${line}\n`, "latin1"));
  }
  return { data: Buffer.concat(out), replaced: "印の間" };
}

// 親が渡す、写す参照の1件（--refs の JSON の配列の要素。acceptance-records の ref-candidates.json も同じ形）
export interface Ref {
  type: RefType;
  // file: 絶対パス（~ で始まってよい）、git: リポジトリの絶対パス、document: Document ID、url: URL
  source: string;
  // git だけ: 名指しの revision（無ければ取得時の HEAD）、ファイル、版履歴か
  revision?: string;
  path?: string;
  history?: boolean;
  kind: RefKind;
  // 参照元（activity:<id>・activity@<時刻>・document:<ID>・受け入れ確認担当の行 <要求の出典>・利用者の明示）と、写しの該当箇所・参照の原文
  from: string;
  at: string;
  quote: string;
  // 参照で指定された版（原文のまま。無ければ「記載なし」）
  version: string;
}

// 目録の1項目（acceptance-input/records.md の1行。parent/acceptance/items.json に同じものを残す）
export interface CatalogItem {
  id: string;
  kind: string;
  from: string;
  source: string;
  version: string;
  method: string;
  identity: string;
  versionMatch: string;
  quote: string;
  obtained: boolean;
  // COPIED・CI_RESULT_EXCLUDED・NOT_COPIED・LINKED_DOCUMENT と、取得不能の理由（copy-evidence.ts の code、NOT_HTTPS・AUTH_REQUIRED・REVISION_NOT_FOUND・NO_LOCATION・CASE_UNAVAILABLE など）
  code: string;
  status: string;
  at: string;
  // 担当へ渡す写し（acceptance-input/ からの相対パス）と、CI の結果を除く前の元の写し（W からの相対パス）
  copies: { path: string; sha256: string }[];
  originals: { name: string; path: string; sha256: string }[];
}

export interface Exclusion {
  item: string;
  what: string;
  sha256: string;
}

interface Command {
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  at: string;
}

// acceptance-records の記録（parent/acceptance/records.json）
interface RecordsState {
  takenAt: string;
  mode: "issue" | "request" | "case";
  issue: string | null;
  case: string | null;
  verdict: { file: string; attempt: number; agentId: string | null; sha256: string };
  items: CatalogItem[];
  exclusions: Exclusion[];
  linkedDocuments: string[];
  commands: Command[];
  // acceptance-input/records/ の各ファイルの sha256 と出典（写したとき）
  files: (FileHash & { source: string })[];
}

interface ActivityItem {
  kind?: string;
  id?: number | null;
  at?: string;
  actor?: string;
  body?: string;
  logKind?: string | null;
  type?: string | null;
  data?: unknown;
  resolvedAt?: string | null;
  replies?: ActivityItem[];
  // 確認依頼（kind: question）
  question?: string;
  answer?: string | null;
  answeredBy?: string | null;
  answeredAt?: string | null;
}

// Activity の項目 ID（records.md と同じ。コメント・作業ログ・返信は activity:<id>、それ以外は activity@<時刻>、同じ ID の2件目からは #<n> を付ける）
function activityId(a: ActivityItem, seen: Map<string, number>): string {
  const base = (a.kind ?? "comment") === "comment" && typeof a.id === "number" ? `activity:${a.id}` : `activity@${a.at ?? "時刻なし"}`;
  const dup = (seen.get(base) ?? 0) + 1;
  seen.set(base, dup);
  return dup > 1 ? `${base}#${dup}` : base;
}

// Activity の全項目（返信を含め、目録と同じ順）と項目 ID・返信先のコメントの id
function flattenActivity(list: ActivityItem[]): { id: string; item: ActivityItem; parent: number | null }[] {
  const seen = new Map<string, number>();
  const out: { id: string; item: ActivityItem; parent: number | null }[] = [];
  const walk = (items: ActivityItem[], parent: number | null) => {
    for (const a of items) {
      out.push({ id: activityId(a, seen), item: a, parent });
      if (Array.isArray(a.replies)) walk(a.replies, typeof a.id === "number" ? a.id : parent);
    }
  };
  walk(list, null);
  return out;
}

// 項目の本文の sha256（目録と同じ。本文の無い項目は項目の JSON）
const activitySha = (a: ActivityItem) => sha256(typeof a.body === "string" ? a.body : JSON.stringify(a));

// 写しの中の Git の revision らしい文字列（リポジトリが分からないので、親が確かめて参照の一覧へ足すか決める）
interface Hint {
  text: string;
  from: string;
  at: string;
  quote: string;
  inClone: boolean;
}

const isCiActivity = (a: ActivityItem) => (a.kind ?? "comment") === "comment" && (a.body ?? "").startsWith(CI_LOG);
const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

// 実行したコマンドの全文と結果を親専用の記録へ残して実行する
function run(argv: string[], log: Command[]): Proc {
  const p = exec(argv);
  const stdout = p.stdout.length <= 4096 ? p.stdout.toString() : `（${p.stdout.length} バイト、sha256 ${sha256(p.stdout)}）`;
  log.push({ argv, exitCode: p.code, stdout, stderr: (p.error ?? p.stderr).trim(), at: now() });
  return p;
}

// 反証が合格し、構造と担当行を残した最新の試行（隔離済み・未検査・不合格なら引数の誤り）
function passedRefute(work: string): { check: CheckRecord; structure: RefuteStructure } {
  const attempt = currentAttempt(work, "refute");
  const check = loadList<CheckRecord>(work, "checks")
    .filter((c) => c.stage === "refute" && c.attempt === attempt.attempt)
    .at(-1);
  const file = join(work, "parent/refute-structure.json");
  const structure = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RefuteStructure) : null;
  if (!check?.valid || !structure || structure.attempt !== attempt.attempt || structure.sha256 !== check.sha256) {
    throw new UsageError(`反証の試行 ${attempt.attempt} が check-refute に合格していないので、受け入れ確認への入力を作りません`);
  }
  return { check, structure };
}

const URL_IN_TEXT = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>`"'()[\]{}|、。，（）「」]+/g;
const PATH_IN_TEXT = /(^|[\s`'"([（「:：=・、])((?:~\/|\/)[^\s`'"()[\]{}<>|、。，（）「」]+)/g;
const DOC_IN_TEXT = /(?:Document|ドキュメント)\s*(?:ID\s*)?[#:：]?\s*(\d+)|\bdoc\s+show\s+(\d+)|\bdocument:(\d+)/gi;
const SHA_IN_TEXT = /\b[0-9a-f]{40}\b/g;
const TRAILING = /[.,;:!?。、，）)」』]+$/;

// 写しの本文から、絶対パス・URL・Document ID・Git の revision らしい文字列を場所付きで挙げる（親が確かめて参照の一覧を決める）
function scanReferences(text: string, from: string, at: (line: number) => string, kind: RefKind, refs: Ref[], hints: Hint[], clone: string): void {
  text.split("\n").forEach((line, i) => {
    const quote = line.trim().slice(0, 300);
    const version = line.match(SHA_IN_TEXT)?.[0] ?? "記載なし";
    const push = (type: RefType, source: string) => {
      if (!refs.some((r) => r.type === type && r.source === source && r.from === from)) refs.push({ type, source, kind, from, at: at(i + 1), quote, version });
    };
    let rest = line;
    for (const m of line.matchAll(URL_IN_TEXT)) {
      push("url", m[0].replace(TRAILING, ""));
      rest = rest.replace(m[0], " ");
    }
    for (const m of rest.matchAll(PATH_IN_TEXT)) {
      const path = (m[2] ?? "").replace(TRAILING, "").replace(/:L\d+(?:-L?\d+)?$/, "");
      if (path.length > 1 && path !== "~/") push("file", path);
    }
    for (const m of rest.matchAll(DOC_IN_TEXT)) push("document", m[1] ?? m[2] ?? m[3] ?? "");
    for (const sha of line.match(SHA_IN_TEXT) ?? []) {
      if (!hints.some((h) => h.text === sha && h.from === from)) hints.push({ text: sha, from, at: at(i + 1), quote, inClone: git(clone, "cat-file", "-e", `${sha}^{commit}`).code === 0 });
    }
  });
}

function renderCandidates(refs: Ref[], hints: Hint[]): string {
  return [
    "# 受け入れ確認の証拠として写す参照の候補",
    "",
    "Activity・添付 Document の写し（CI の結果を除いた後）と、反証の判定本文の「受け入れ確認担当の行」の「必要な外部の正本」の欄から、絶対パス・URL・Document ID を機械的に挙げた候補（Issue にリンクされた Document は records/ に写したので挙げない）。",
    "親は写しの該当箇所（場所の列）で確かめ、漏れた明示参照を足し、参照でないものを除いて、`ref-candidates.json` と同じ形の一覧を acceptance-input の --refs に渡す。要否や関連では選ばない。Git のリポジトリと revision の参照は type を git にし、revision と path（版履歴なら history: true）を足す。",
    "",
    "| # | type | 出典 | 種類 | 参照元 | 場所 | 行の原文 |",
    "|---|---|---|---|---|---|---|",
    ...refs.map((r, i) => `| ${i + 1} | ${r.type} | \`${cell(r.source)}\` | ${r.kind} | ${cell(r.from)} | ${cell(r.at)} | ${cell(r.quote)} |`),
    "",
    "## 要確認: Git の revision らしい文字列",
    "",
    "リポジトリが書かれていないので候補にしていない。限定 clone にある commit は対象リポジトリの commit で、写さない（担当が限定 clone の固定版で読む）。",
    "",
    ...(hints.length > 0
      ? ["| 文字列 | 参照元 | 場所 | 行の原文 | 限定 clone |", "|---|---|---|---|---|", ...hints.map((h) => `| \`${h.text}\` | ${cell(h.from)} | ${cell(h.at)} | ${cell(h.quote)} | ${h.inClone ? "ある（写さない）" : "無い"} |`)]
      : ["なし"]),
    "",
  ].join("\n");
}

function acceptanceRecords(args: string[]): Outcome {
  const o = parseOptions(args, ["work"], []);
  const { work, prep } = loadWork(o);
  const { check, structure } = passedRefute(work);
  if (!structure.acceptanceRequired) throw new UsageError("受け入れ確認担当の行が0行なので、受け入れ確認担当を起動せず、受け入れ確認への入力も作りません");
  const A = join(work, "acceptance-input");
  const P = join(work, "parent/acceptance");
  if ((existsSync(A) && readdirSync(A).length > 0) || existsSync(join(P, "records.json"))) throw new UsageError(`受け入れ確認への写しは取り済みです（写し直しません）: ${A}`);
  for (const d of [A, P, join(work, "acceptance/notes")]) mkdirSync(d, { recursive: true });
  // 共通入力と反証の判定本文（丸ごと）
  for (const name of ["target.md", "manifest.md", "requirements", "local", "deps-files.sha256"]) {
    const src = join(work, "input", name);
    if (existsSync(src)) copyTree(src, join(A, name));
  }
  copyFileSync(join(work, check.file), join(A, "refute-verdict.md"));

  const takenAt = now();
  const mode: RecordsState["mode"] = prep.caseDir ? "case" : prep.issue ? "issue" : "request";
  const items: CatalogItem[] = [];
  const exclusions: Exclusion[] = [];
  const commands: Command[] = [];
  const linked: string[] = [];
  const files: (FileHash & { source: string })[] = [];
  const candidates: Ref[] = [];
  const hints: Hint[] = [];
  const clone = join(work, "repo");
  const issue = prep.issue;
  if (mode === "issue" && issue) {
    // 委譲の直前の全 Activity と、現在リンクされた全 Document（kind を問わない）。元の写しは親専用領域に残す
    const p = run([process.env.NOD_CLI || "nod", "--json", "issue", "show", issue], commands);
    writeFileSync(join(P, "issue-snapshot.json"), p.stdout);
    const shown = parseJson(p) as { activity?: unknown; documents?: unknown } | undefined;
    const rawActivity = shown?.activity;
    const rawDocuments = shown?.documents;
    const unavailable = (id: string, kind: string, source: string, reason: string) =>
      items.push({ id, kind, from: `Issue ${issue}`, source, version: "対象外", method: "nod", identity: "取得できず", versionMatch: "対象外", quote: "写しなし", obtained: false, code: "READ_FAILED", status: `取得不能: ${reason}`, at: takenAt, copies: [], originals: [] });
    if (p.code !== 0 || !Array.isArray(rawActivity)) {
      unavailable("activity", "Activity", `nod --json issue show ${issue}`, `nod issue show が失敗（${failure(p)}）`);
    } else {
      const activity = rawActivity as ActivityItem[];
      writeFileSync(join(P, "activity.json"), `${JSON.stringify(activity, null, 2)}\n`);
      const keep = (list: ActivityItem[]): ActivityItem[] => list.filter((a) => !isCiActivity(a)).map((a) => (Array.isArray(a.replies) ? { ...a, replies: keep(a.replies) } : a));
      mkdirSync(join(A, "records"), { recursive: true });
      writeFileSync(join(A, "records/activity.json"), `${JSON.stringify(keep(activity), null, 2)}\n`);
      const seen = new Map<string, number>();
      const walk = (list: ActivityItem[], parent: number | null, removedWith: number | null) => {
        for (const a of list) {
          const comment = (a.kind ?? "comment") === "comment";
          const id = activityId(a, seen);
          const body = typeof a.body === "string" ? a.body : null;
          const ci = isCiActivity(a);
          const excluded = ci || removedWith !== null;
          const sha = activitySha(a);
          const where = `records/activity.json の ${id}`;
          if (excluded && comment) {
            const what = ci ? (parent !== null ? "本文が [ci-result] で始まる返信" : `本文が [ci-result] で始まる${a.logKind ? `作業ログ（${a.logKind}）` : "コメント"}（返信ごと）`) : `本文が [ci-result] で始まる activity:${removedWith} とともに除いた返信`;
            exclusions.push({ item: parent !== null ? `activity:${parent} の返信 ${a.id}` : `activity:${a.id}`, what, sha256: sha });
          }
          const kind = !comment ? `Activity（イベント ${a.type ?? "不明"}）` : a.logKind ? `Activity（作業ログ ${a.logKind}）` : parent !== null ? "Activity（返信）" : "Activity（コメント）";
          items.push({
            id,
            kind,
            from: parent !== null ? `Issue ${issue} の activity:${parent} への返信` : `Issue ${issue}`,
            source: `Issue ${issue} の Activity（${takenAt}）`,
            version: "対象外（Activity の項目）",
            method: "nod issue show（Activity）",
            identity: `${comment ? "本文" : "項目"}の sha256 ${sha}（${a.actor ?? "書いた人不明"}、${a.at ?? "時刻なし"}${a.resolvedAt ? "、解決済み" : ""}）`,
            versionMatch: "対象外",
            quote: excluded ? "写しなし（CI の結果として除外）" : where,
            obtained: !excluded,
            code: excluded ? "CI_RESULT_EXCLUDED" : "COPIED",
            status: excluded ? "除外: CI の結果は親だけが扱う（CI の結果の除外の節）" : "取得",
            at: takenAt,
            copies: excluded ? [] : [{ path: where, sha256: sha }],
            originals: [{ name: "元の本文", path: `parent/acceptance/activity.json の ${id}`, sha256: sha }],
          });
          if (!excluded && body !== null) scanReferences(body, id, (n) => `${where}（本文の L${n}）`, "参照された記録", candidates, hints, clone);
          const root = typeof a.id === "number" ? a.id : parent;
          if (Array.isArray(a.replies)) walk(a.replies, root, excluded ? (removedWith ?? root) : null);
        }
      };
      walk(activity, null, null);
      const copiedSha = sha256(readFileSync(join(A, "records/activity.json")));
      files.push({ path: "records/activity.json", sha256: copiedSha, source: `Issue ${issue} の Activity（nod --json issue show、${takenAt}）から CI の結果を印で除いた写し` });
    }
    const documents = Array.isArray(rawDocuments) ? (rawDocuments as DocRow[]) : [];
    for (const d of documents) {
      const id = String(d.id);
      linked.push(id);
      const name = `document-${id}.md`;
      const dp = run([process.env.NOD_CLI || "nod", "--json", "doc", "show", id], commands);
      const doc = parseJson(dp) as { content?: unknown; path?: unknown; kind?: unknown } | undefined;
      if (dp.code !== 0 || typeof doc?.content !== "string") {
        unavailable(`document:${id}`, `Document（kind=${d.kind ?? "不明"}）`, `Document ${id}（${d.path ?? ""}）`, `nod doc show が失敗（${failure(dp)}）`);
        continue;
      }
      const original = Buffer.from(doc.content);
      mkdirSync(join(P, "documents"), { recursive: true });
      writeFileSync(join(P, "documents", name), original);
      const stripped = ciStrip(original);
      mkdirSync(join(A, "records/documents"), { recursive: true });
      writeFileSync(join(A, "records/documents", name), stripped.data);
      if (stripped.replaced) exclusions.push({ item: `document:${id}`, what: stripped.replaced, sha256: sha256(original) });
      const source = `Document ${id}（kind=${String(doc.kind ?? d.kind ?? "")}、${String(doc.path ?? d.path ?? "")}、${takenAt}）`;
      files.push({ path: `records/documents/${name}`, sha256: sha256(stripped.data), source });
      items.push({
        id: `document:${id}`,
        kind: `Document（kind=${String(doc.kind ?? d.kind ?? "")}）`,
        from: `Issue ${issue} にリンク`,
        source,
        version: "対象外（添付 Document）",
        method: "nod doc show",
        identity: `本文の sha256 ${sha256(original)}`,
        versionMatch: "対象外",
        quote: `records/documents/${name}`,
        obtained: true,
        code: "COPIED",
        status: stripped.replaced ? `取得（CI の結果を${stripped.replaced}で置き換えた）` : "取得",
        at: takenAt,
        copies: [{ path: `records/documents/${name}`, sha256: sha256(stripped.data) }],
        originals: [{ name: "元の本文", path: `parent/acceptance/documents/${name}`, sha256: sha256(original) }],
      });
      scanReferences(stripped.data.toString("utf8"), `document:${id}`, (n) => `records/documents/${name}:L${n}`, "参照された記録", candidates, hints, clone);
    }
  }
  // 反証が名指しした外部の正本
  for (const row of structure.acceptanceRows) {
    if (!row.canon.startsWith("なし")) scanReferences(row.canon, `受け入れ確認担当の行 ${row.source}`, () => `refute-verdict.md:L${row.line}`, "外部の正本", candidates, hints, clone);
  }
  const refs = candidates.filter((r) => !(r.type === "document" && linked.includes(r.source)));
  writeFileSync(join(P, "ref-candidates.json"), `${JSON.stringify(refs, null, 2)}\n`);
  writeFileSync(join(P, "ref-candidates.md"), renderCandidates(refs, hints));
  const state: RecordsState = {
    takenAt,
    mode,
    issue,
    case: prep.case,
    verdict: { file: check.file, attempt: check.attempt, agentId: check.agentId, sha256: check.sha256 ?? "" },
    items,
    exclusions,
    linkedDocuments: linked,
    commands,
    files,
  };
  writeFileSync(join(P, "records.json"), `${JSON.stringify(state, null, 2)}\n`);
  const result = {
    mode,
    takenAt,
    activity: items.filter((i) => i.id.startsWith("activity")).length,
    documents: linked.length,
    excluded: exclusions,
    candidates: refs.length,
    hints: hints.length,
    candidatesFile: join(P, "ref-candidates.json"),
    candidatesList: join(P, "ref-candidates.md"),
  };
  return { work, result };
}

// --refs の参照の一覧（JSON の配列）。読めない要素は引数の誤りにする（親が直して実行し直す）
function readRefs(path: string): Ref[] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new UsageError(`--refs を JSON として読めません: ${path}（${e instanceof Error ? e.message : String(e)}）`);
  }
  if (!Array.isArray(data)) throw new UsageError("--refs は参照の配列の JSON にしてください（写す参照が無ければ []）");
  const problems: string[] = [];
  const refs: Ref[] = [];
  data.forEach((raw: unknown, i) => {
    const o: Record<string, unknown> = raw !== null && typeof raw === "object" ? { ...raw } : {};
    const text = (k: string) => {
      const v = o[k];
      return typeof v === "string" ? v.trim() : "";
    };
    const type = REF_TYPES.find((t) => t === text("type"));
    const kind = REF_KINDS.find((k) => k === text("kind"));
    const bad: string[] = [];
    if (!type) bad.push(`type（${REF_TYPES.join("・")}）`);
    if (!kind) bad.push(`kind（${REF_KINDS.join("・")}）`);
    for (const k of ["source", "from", "at", "quote"]) if (!text(k)) bad.push(k);
    for (const k of ["revision", "path", "version"]) if (o[k] !== undefined && typeof o[k] !== "string") bad.push(k);
    if (o.history !== undefined && typeof o.history !== "boolean") bad.push("history");
    if (type !== "git" && (o.revision !== undefined || o.path !== undefined || o.history !== undefined)) bad.push("revision・path・history は git だけ");
    if (type === "git" && !isAbsolute(expandHome(text("source")))) bad.push("source（Git のリポジトリの絶対パス）");
    if (type === "git" && o.history === true && !text("path")) bad.push("path（版履歴を読むファイル）");
    if (type === "document" && !DOC_REF.test(text("source"))) bad.push("source（Document ID）");
    if (bad.length > 0 || !type || !kind) return problems.push(`${i + 1} 件目: ${bad.join("・")}`);
    refs.push({
      type,
      source: text("source"),
      ...(text("revision") ? { revision: text("revision") } : {}),
      ...(text("path") ? { path: text("path") } : {}),
      ...(o.history === true ? { history: true } : {}),
      kind,
      from: text("from"),
      at: text("at"),
      quote: text("quote"),
      version: text("version") || "記載なし",
    });
  });
  if (problems.length > 0) throw new UsageError(`--refs の参照を読めません（${problems.join("。")}）`);
  return refs;
}

// 取得の結果（ファイルは parent/acceptance/evidence/<n>/ に書いた元の写し）
interface Fetched {
  code: string;
  obtained: boolean;
  reason: string;
  method: string;
  identity: string;
  versionMatch: string;
  facts: Json;
}

// path がこのレビューの作業ディレクトリ・レビューの作業ディレクトリ・常設データセットの配下か（大文字小文字と Unicode の正規化を区別しない）
function forbiddenArea(path: string, work: string, homeAreas: boolean): string | null {
  const fold = (p: string) => p.normalize("NFC").toLowerCase();
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const homes = homeAreas ? [...new Set([homedir(), real(homedir())])] : [];
  const roots = [...new Set([work, real(work), ...homes.flatMap((h) => FORBIDDEN_AREAS.map((a) => join(h, a)))])];
  for (const candidate of new Set([path, real(path)])) {
    const hit = roots.find((root) => fold(candidate) === fold(root) || fold(candidate).startsWith(`${fold(root)}/`));
    if (hit) return hit;
  }
  return null;
}

// 参照1件を、出典の形に応じた1つの読み取りだけで dir（親専用領域の evidence/<n>）へ写す（parent.md 8.1 の表）
function fetchEvidence(ref: Ref, dir: string, ctx: { work: string; prep: Prepared; linked: string[] }, log: Command[]): Fetched {
  const fail = (code: string, reason: string, method: string, facts: Json = {}): Fetched => {
    rmSync(dir, { recursive: true, force: true });
    return { code, obtained: false, reason, method, identity: "取得できず", versionMatch: "取得できず", facts };
  };
  if (ref.type === "file") {
    const method = "通常のファイル: copy-evidence.ts（本文を開く前に名前と各要素を検査し、ファイル1つと観測を写す）";
    const path = expandHome(ref.source);
    if (!isAbsolute(path)) return fail("NOT_COPIED", "リポジトリ内の相対パス（写さない。担当が限定 clone の固定版で読む）", "写さない");
    if (forbiddenArea(path, ctx.work, false)) return fail("FORBIDDEN_AREA", "このレビューの作業ディレクトリの配下（担当へ渡さない）", method);
    mkdirSync(dirname(dir), { recursive: true });
    const p = run([process.execPath, join(import.meta.dir, "copy-evidence.ts"), ref.source, dir], log);
    const j = parseJson(p) as { code?: string; message?: string; secrets?: { match?: string }[]; observationSha256?: string } | undefined;
    if (p.code !== 0) {
      const secrets = (j?.secrets ?? []).map((s) => s.match).filter(Boolean);
      return fail(j?.code ?? "UNEXPECTED_ERROR", `${j?.message ?? failure(p)}${secrets.length > 0 ? `（当たったパス: ${secrets.join("・")}）` : ""}`, method, { exitCode: p.code, result: j ?? null });
    }
    const observation = readFileSync(join(dir, "observation.txt"), "utf8").trim().split("\t");
    return { code: "COPIED", obtained: true, reason: "", method, identity: `observation.txt の sha256 ${j?.observationSha256 ?? ""}（${observation[2] ?? "?"} バイト、本文の sha256 ${observation[3] ?? "?"}）`, versionMatch: UNCHECKED, facts: { result: j ?? null } };
  }
  if (ref.type === "git") {
    const repo = expandHome(ref.source);
    const rev = ref.revision ?? "HEAD";
    const method = ref.history ? "Git: rev-parse で commit に固定し、git log で版履歴を読む" : ref.path ? "Git: rev-parse で commit に固定し、git show でファイルを読む" : "Git: rev-parse で commit に固定し、git log -1 で commit を読む";
    const secret = [repo, ...(ref.path ? [ref.path] : [])].find((n) => SECRET.test(n));
    if (secret) return fail("SECRET_CANDIDATE", `秘密情報を含み得る名前（当たったパス: ${secret}）`, method);
    if (repo.split("/").slice(1).some((s) => s === "" || s === "." || s === "..") || (ref.path ?? "").split("/").some((s) => s === "." || s === "..")) {
      return fail("NON_CANONICAL_PATH", ". や .. や空の要素を含むパス", method);
    }
    if (forbiddenArea(repo, ctx.work, true)) return fail("FORBIDDEN_AREA", "レビューの作業ディレクトリか常設データセットの配下（担当へ渡さない）", method);
    if (!existsSync(repo)) return fail("NOT_FOUND", "リポジトリのパスが存在しない", method);
    if (run(["git", "-C", repo, "rev-parse", "--git-dir"], log).code !== 0) return fail("NOT_FOUND", "Git のリポジトリではない", method);
    const c = run(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`], log);
    if (c.code !== 0) return fail("REVISION_NOT_FOUND", `名指しの Git の revision が無い（${rev}。名指しの版との対応を示せない）`, method);
    const commit = c.stdout.toString().trim();
    const named = SHA.test(rev) ? "" : run(["git", "-C", repo, "rev-parse", "--symbolic-full-name", rev], log).stdout.toString().trim();
    const same = [ctx.prep.repo, ...(existsSync(ctx.prep.repo) ? [realpathSync(ctx.prep.repo)] : [])].includes(realpathSync(repo));
    if (same && git(join(ctx.work, "repo"), "cat-file", "-e", `${commit}^{commit}`).code === 0) {
      return fail("NOT_COPIED", `対象リポジトリの commit ${commit}（写さない。担当が限定 clone の固定版で読む）`, "写さない", { commit });
    }
    mkdirSync(dir, { recursive: true });
    const read = ref.history
      ? { argv: ["git", "-C", repo, "--no-pager", "log", "--no-ext-diff", "--no-textconv", "--format=%H%x09%cI%x09%aI%x09%s", commit, "--", ref.path ?? ""], name: "history.txt" }
      : ref.path
        ? { argv: ["git", "-C", repo, "--no-pager", "show", "--no-textconv", `${commit}:${ref.path}`], name: basename(ref.path) }
        : { argv: ["git", "-C", repo, "--no-pager", "log", "-1", "--no-ext-diff", "--no-textconv", "--format=%H%x09%cI%x09%aI%x09%s", commit], name: "commit.txt" };
    const p = run(read.argv, log);
    if (p.code !== 0) return fail("READ_FAILED", `Git の読み取りが失敗（${failure(p)}）`, method, { commit });
    writeFileSync(join(dir, read.name), p.stdout);
    const pointed = named && named !== rev ? `（名前で指した revision ${rev}（${named}）が指す commit）` : rev === "HEAD" ? "（revision の指定なし。取得時の HEAD）" : "";
    return { code: "COPIED", obtained: true, reason: "", method, identity: `commit ${commit}${pointed}`, versionMatch: `commit ${commit} に固定${pointed}`, facts: { commit, revision: rev, symbolic: named || null } };
  }
  if (ref.type === "document") {
    const id = DOC_REF.exec(ref.source)?.[1] ?? ref.source;
    const method = "Document: nod doc show の本文";
    if (ctx.linked.includes(id)) return fail("LINKED_DOCUMENT", `Issue にリンクされた Document（document:${id} として records/ に写した）`, "写さない");
    const p = run([process.env.NOD_CLI || "nod", "--json", "doc", "show", id], log);
    const doc = parseJson(p) as { content?: unknown; path?: unknown; kind?: unknown } | undefined;
    if (p.code !== 0 || typeof doc?.content !== "string") return fail("READ_FAILED", `nod doc show が失敗（${failure(p)}）`, method);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `document-${id}.md`), doc.content);
    return { code: "COPIED", obtained: true, reason: "", method, identity: `本文の sha256 ${sha256(doc.content)}（kind=${String(doc.kind ?? "")}、${String(doc.path ?? "")}）`, versionMatch: UNCHECKED, facts: { id, path: doc.path ?? null } };
  }
  const method = "https の URL: 認証情報・cookie・設定ファイルを使わない GET を1回（curl）";
  let url: URL;
  try {
    url = new URL(ref.source);
  } catch {
    return fail("NOT_URL", "URL として読めない", method);
  }
  if (url.username || url.password) return fail("SECRET_CANDIDATE", "利用者情報（user:pass@）を含む URL（秘密候補）", method);
  const secretKey = [...url.searchParams.keys()].find((k) => SECRET_QUERY.test(k));
  if (secretKey) return fail("SECRET_CANDIDATE", `名前に秘密らしい語を含むクエリ ${secretKey} を持つ URL（秘密候補）`, method);
  if (url.protocol !== "https:") return fail("NOT_HTTPS", `https:// 以外の URL（${url.protocol}。読み取り手段が無い）`, method);
  mkdirSync(dir, { recursive: true });
  const argv = ["curl", "-q", "-fsS", "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "5", "--max-time", "60", "--max-filesize", "20000000"];
  const p = run([...argv, "-D", join(dir, "headers.txt"), "-o", join(dir, "body"), "-w", "%{http_code} %{url_effective}\\n", ref.source], log);
  const [status = "", finalUrl = ""] = p.stdout.toString().trim().split(" ");
  if (p.code !== 0 || !existsSync(join(dir, "body"))) {
    const auth = ["401", "403", "407"].includes(status);
    return fail(auth ? "AUTH_REQUIRED" : "READ_FAILED", auth ? `認証が要る（HTTP ${status}）` : `curl が失敗（${failure(p)}${status ? `、HTTP ${status}` : ""}）`, method, { status });
  }
  const headers = existsSync(join(dir, "headers.txt")) ? readFileSync(join(dir, "headers.txt"), "utf8") : "";
  const header = (name: string) => new RegExp(`^${name}:\\s*(.*?)\\s*$`, "im").exec(headers)?.[1];
  const etag = header("etag");
  const modified = header("last-modified");
  const body = sha256(readFileSync(join(dir, "body")));
  const identity = `HTTP ${status}、最終の URL ${finalUrl}、本文の sha256 ${body}${etag ? `、ETag ${etag}` : ""}${modified ? `、Last-Modified ${modified}` : ""}`;
  return { code: "COPIED", obtained: true, reason: "", method, identity, versionMatch: UNCHECKED, facts: { status, finalUrl, etag: etag ?? null, lastModified: modified ?? null } };
}

function renderCatalog(state: RecordsState, items: CatalogItem[], files: FileHash[], sources: Map<string, string>, exclusions: Exclusion[], note: string | null, fetchedAt: string): string {
  const target =
    state.mode === "issue"
      ? `Issue ${state.issue}（Activity と添付 Document は ${state.takenAt} に取得）`
      : state.mode === "case"
        ? `評価用の事例 ${state.case}（nod から取らず、事例の入力に固定した証拠だけを写した）`
        : "Issue なし（Activity・添付 Document は写さない）";
  const copies = (i: CatalogItem) => i.copies.map((c) => `\`${c.path}\` ${c.sha256}`).join("・") || "写しなし";
  const originals = (i: CatalogItem) => i.originals.map((o) => `${o.name} ${o.sha256}`).join("・") || "なし";
  return [
    "# 受け入れ確認の目録",
    "",
    `- 対象: ${target}`,
    `- 写した時刻: ${state.takenAt}（証拠の取得: ${fetchedAt}）`,
    "- 読み方: 1項目1行。全文を通読せず、`grep -n` で必要な項目 ID・参照元・要求の出典の行だけを引く。判定に使った証拠の節には、この表の項目 ID を書く。",
    ...(note ? [`- ${note}`] : []),
    "",
    "## 項目",
    "",
    "| 項目 ID | 種類 | 参照元 | 出典 | 参照で指定された版 | 取得方法 | 取得物の識別情報 | 版の対応 | 参照の原文 | 取得の可否と理由 | 取得時刻 | 写し先と sha256 | 元の写しの sha256 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...items.map((i) =>
      [i.id ? `\`${i.id}\`` : "", i.kind, i.from, i.source, i.version, i.method, i.identity, i.versionMatch, i.quote, i.status, i.at, copies(i), originals(i)].map((c, k) => (k === 0 ? c : cell(c || "なし"))).join(" | "),
    ).map((row) => `| ${row} |`),
    ...(items.length === 0 ? ["", "項目なし"] : []),
    "",
    "## ファイルの sha256 と出典（records.md を除く）",
    "",
    "| ファイル | sha256 | 出典 |",
    "|---|---|---|",
    ...files.map((f) => `| \`${f.path}\` | \`${f.sha256}\` | ${cell(sources.get(f.path) ?? "不明")} |`),
    "",
    "## CI の結果の除外",
    "",
    "親が印だけで除いた CI の結果。写しの「（CI の結果は親だけが扱うため除いた）」は除いた跡で、改変や不足ではない。除かれた中身を推測しない。",
    "",
    ...(exclusions.length > 0 ? ["| 項目 | 除いたもの | 元の sha256 |", "|---|---|---|", ...exclusions.map((e) => `| ${cell(e.item)} | ${cell(e.what)} | \`${e.sha256}\` |`)] : ["なし"]),
    "",
  ].join("\n");
}

function acceptanceInput(args: string[]): Outcome {
  const o = parseOptions(args, ["work", "refs"], []);
  const { work, prep } = loadWork(o);
  const { check, structure } = passedRefute(work);
  const A = join(work, "acceptance-input");
  const P = join(work, "parent/acceptance");
  const stateFile = join(P, "records.json");
  if (!existsSync(stateFile)) throw new UsageError("acceptance-records で共通入力・反証の判定本文・Activity・添付 Document を写してから実行してください");
  if (existsSync(join(work, "parent/acceptance-input.json"))) throw new UsageError("受け入れ確認への入力は作り済みです（作り直しません）");
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as RecordsState;
  const refsPath = absolute("refs", o.one.get("refs"));
  if (state.mode !== "case" && !refsPath) throw new UsageError("--refs <写す参照の一覧の JSON の絶対パス> が要ります（写す参照が無ければ [] のファイル）");
  const refs = refsPath ? readRefs(refsPath) : [];
  if (refsPath) copyFileSync(refsPath, join(P, "refs.json"));

  const items = [...state.items];
  const exclusions = [...state.exclusions];
  const sources = new Map(state.files.map((f) => [f.path, f.source]));
  const details: Json[] = [];
  const caseMismatches: string[] = [];
  const evidenceFiles: FileHash[] = [];
  let n = 0;
  // 元の写し（親専用領域）の各ファイルから CI の結果を印だけで除いて、担当への写しを作る
  const publish = (no: number, base: Omit<CatalogItem, "id" | "copies" | "originals" | "at">, fetched: { obtained: boolean }, at: string) => {
    const D = join(P, "evidence", String(no));
    const item: CatalogItem = { id: `evidence/${no}`, ...base, at, copies: [], originals: [] };
    if (fetched.obtained && existsSync(D)) {
      for (const name of readdirSync(D).sort()) {
        const original = readFileSync(join(D, name));
        const stripped = ciStrip(original);
        const rel = `evidence/${no}/${name}`;
        mkdirSync(join(A, "evidence", String(no)), { recursive: true });
        writeFileSync(join(A, rel), stripped.data);
        if (stripped.replaced) exclusions.push({ item: rel, what: stripped.replaced, sha256: sha256(original) });
        item.copies.push({ path: rel, sha256: sha256(stripped.data) });
        item.originals.push({ name, path: `parent/acceptance/${rel}`, sha256: sha256(original) });
        evidenceFiles.push({ path: rel, sha256: sha256(stripped.data) });
        sources.set(rel, `${base.source}（${item.id}）`);
      }
    }
    items.push(item);
    return item;
  };

  // 評価用: 事例の入力に固定した証拠（inputs/<case-id>/evidence/）を写し、事例の manifest.md と照合する（copy-evidence.ts を通さない）
  if (state.mode === "case") {
    if (!prep.caseDir) throw new UsageError("prepare の記録に事例の入力の場所（caseDir）がありません。prepare --case からやり直してください");
    const c = readCase(prep.caseDir);
    for (const e of walkEntries(join(c.dir, "evidence"))) {
      n += 1;
      const rel = `evidence/${e.rel.slice(2)}`;
      const at = now();
      const D = join(P, "evidence", String(n));
      const base = { kind: "事例の入力に固定した証拠", from: `評価用の事例 inputs/${c.id}`, source: `inputs/${c.id}/${rel}`, version: "事例の入力に固定した版", method: "事例の入力 inputs/<case-id>/evidence/ から写す（copy-evidence.ts を通さない）", quote: `inputs/${c.id}/manifest.md の ${rel} の行` };
      if (e.kind !== "file") {
        caseMismatches.push(`${rel}（通常のファイルではない）`);
        publish(n, { ...base, identity: "取得できず", versionMatch: "取得できず", obtained: false, code: "NOT_REGULAR_FILE", status: "取得不能: 通常のファイルではない" }, { obtained: false }, at);
        continue;
      }
      mkdirSync(D, { recursive: true });
      const data = readFileSync(e.path);
      writeFileSync(join(D, basename(e.path)), data);
      const want = c.hashes.get(rel);
      const ok = want === sha256(data);
      if (!ok) caseMismatches.push(`${rel}（manifest.md: ${want ?? "記載なし"}、写し: ${sha256(data)}）`);
      const versionMatch = ok ? "事例の manifest.md の sha256 と一致" : `事例の manifest.md の sha256（${want ?? "記載なし"}）と不一致`;
      publish(n, { ...base, identity: `sha256 ${sha256(data)}（${versionMatch}）`, versionMatch, obtained: true, code: ok ? "COPIED" : "MANIFEST_MISMATCH", status: ok ? "取得" : "取得（manifest.md と不一致）" }, { obtained: true }, at);
      details.push({ id: `evidence/${n}`, source: e.path, manifest: want ?? null, sha256: sha256(data), commands: [] });
    }
  }

  // 親が渡した明示参照（同じ出典・版の参照は1項目にまとめる）
  const groups: Ref[][] = [];
  for (const r of refs) {
    const key = (x: Ref) => [x.type, x.type === "git" || x.type === "file" ? expandHome(x.source) : x.source, x.revision ?? "", x.path ?? "", x.history ? "1" : ""].join("\0");
    const g = groups.find((list) => list[0] && key(list[0]) === key(r));
    if (g) g.push(r);
    else groups.push([r]);
  }
  for (const g of groups) {
    const head = g[0];
    if (!head) continue;
    n += 1;
    const D = join(P, "evidence", String(n));
    const log: Command[] = [];
    const at = now();
    const fetched: Fetched =
      state.mode === "case"
        ? { code: "CASE_UNAVAILABLE", obtained: false, reason: "当時の版を取れない（評価用。事例の入力に固定した証拠だけを写す）", method: "取りに行かない", identity: "取得できず", versionMatch: "取得できず", facts: {} }
        : fetchEvidence(head, D, { work, prep, linked: state.linkedDocuments }, log);
    const unique = (f: (r: Ref) => string) => [...new Set(g.map(f))].join("・");
    const source = head.type === "git" ? `${head.source}@${head.revision ?? "HEAD"}${head.path ? `:${head.path}` : ""}${head.history ? "（版履歴）" : ""}` : head.source;
    const notCopied = fetched.code === "NOT_COPIED" || fetched.code === "LINKED_DOCUMENT";
    const item = publish(
      n,
      {
        kind: unique((r) => r.kind),
        from: unique((r) => r.from),
        source,
        version: unique((r) => r.version),
        method: fetched.method,
        identity: fetched.identity,
        versionMatch: fetched.versionMatch,
        quote: g.map((r) => `「${r.quote}」（${r.at}）`).join("・"),
        obtained: fetched.obtained,
        code: fetched.code,
        status: fetched.obtained ? "取得" : `${notCopied ? "写さない" : "取得不能"}: ${fetched.code}: ${fetched.reason}`,
      },
      fetched,
      at,
    );
    details.push({ id: item.id, refs: g, type: head.type, source: head.source, revision: head.revision ?? null, path: head.path ?? null, history: head.history ?? false, code: fetched.code, obtained: fetched.obtained, reason: fetched.reason, method: fetched.method, identity: fetched.identity, facts: fetched.facts, commands: log, fetchedAt: at, files: item.originals });
  }

  // 名指しの外部の正本のうち、写せる場所が渡されなかった行（場所を探さない）
  for (const row of structure.acceptanceRows) {
    if (row.canon.startsWith("なし") || refs.some((r) => r.kind === "外部の正本" && norm(r.from).includes(row.source))) continue;
    n += 1;
    const caseMode = state.mode === "case";
    const reason = caseMode ? "当時の版を取れない（評価用。事例の入力に固定した証拠だけを写す）" : "出典の場所が名指しされていない（場所を探さない）";
    const code = caseMode ? "CASE_UNAVAILABLE" : "NO_LOCATION";
    publish(
      n,
      { kind: "外部の正本", from: `受け入れ確認担当の行 ${row.source}`, source: row.canon, version: "記載なし", method: "取りに行かない", identity: "取得できず", versionMatch: "取得できず", quote: `「${row.canon}」（refute-verdict.md:L${row.line}）`, obtained: false, code, status: `取得不能: ${code}: ${reason}` },
      { obtained: false },
      now(),
    );
    details.push({ id: `evidence/${n}`, row: row.source, code, reason, commands: [] });
  }

  const fetchedAt = now();
  const explicit = refs.some((r) => r.kind !== "外部の正本");
  const note =
    state.mode === "request" && !explicit
      ? "Issue なし、明示された証拠なし"
      : state.mode === "case" && !items.some((i) => i.kind === "事例の入力に固定した証拠")
        ? "明示された証拠なし（事例の入力に固定した証拠なし）"
        : null;
  for (const f of fingerprintList(A)) if (!sources.has(f.path)) sources.set(f.path, f.path === "refute-verdict.md" ? `refute/verdict.md（反証 試行 ${check.attempt}、担当 ID ${check.agentId ?? "不明"}、check-refute で検査した sha256 と照合）` : `共通入力 input/${f.path}（manifest.md と同じ出典）`);
  const listed = fingerprintList(A).filter((f) => f.path !== "records.md");
  writeFileSync(join(A, "records.md"), renderCatalog(state, items, listed, sources, exclusions, note, fetchedAt));
  writeFileSync(join(P, "items.json"), `${JSON.stringify(items, null, 2)}\n`);
  writeFileSync(join(P, "evidence.json"), `${JSON.stringify(details, null, 2)}\n`);
  writeFileSync(
    join(P, "evidence.md"),
    [
      "# 証拠の取得の記録（親専用。担当へ渡さない）",
      "",
      "保存直前の取り直しは、同じ出典から同じ読み取りで行う。詳細は evidence.json。",
      "",
      ...details.flatMap((d) => [`## ${String(d.id)}: ${String(d.code)}`, "", "```sh", ...(Array.isArray(d.commands) ? (d.commands as Command[]) : []).map((c) => `${quote(c.argv)}   # exit=${c.exitCode ?? "なし"} ${c.at}`), "```", ""]),
    ].join("\n"),
  );

  // 写した共通入力・反証の判定本文・records/・evidence/ の sha256 を、記録と照合する
  const files = fingerprintList(A);
  const got = new Map(files.map((f) => [f.path, f.sha256]));
  const expected = [
    ...prep.inputs.map((i) => ({ ...i, source: `input/${i.path}（prepare の記録）` })),
    { path: "manifest.md", sha256: prep.manifestSha256 ?? "", source: "input/manifest.md（prepare の記録）" },
    { path: "refute-verdict.md", sha256: check.sha256 ?? "", source: `refute/verdict.md（check-refute で検査した試行 ${check.attempt}）` },
    ...state.files.map((f) => ({ ...f, source: "acceptance-records で写したとき" })),
    ...evidenceFiles.map((f) => ({ ...f, source: "写したとき" })),
  ];
  const comparison = [
    ...expected.map((e) => ({ path: e.path, sha256: e.sha256, source: e.source, copied: got.get(e.path) ?? null, ok: got.get(e.path) === e.sha256 })),
    ...files.filter((f) => f.path !== "records.md" && !expected.some((e) => e.path === f.path)).map((f) => ({ path: f.path, sha256: "", source: "写すものではない", copied: f.sha256, ok: false })),
  ];
  const identity = checkIdentity(work, "explore", "acceptance-input");
  const ready = comparison.every((c) => c.ok) && caseMismatches.length === 0 && identity.ok;
  writeFileSync(
    join(P, "fingerprints.md"),
    [
      "# 受け入れ確認への入力の指紋",
      "",
      `- 写した時刻: ${state.takenAt}（証拠の取得: ${fetchedAt}）`,
      `- 結果: ${ready ? "一致（受け入れ確認を起動してよい）" : `不一致（受け入れ確認を起動しない。未完了（理由: ${ACCEPTANCE_UNFIXED}））`}`,
      "",
      "| ファイル | 写しの sha256 | 照合先 | 照合先の sha256 | 一致 |",
      "|---|---|---|---|---|",
      ...comparison.map((c) => `| \`${c.path}\` | \`${c.copied ?? "無い"}\` | ${cell(c.source)} | \`${c.sha256 || "なし"}\` | ${c.ok ? "一致" : "不一致"} |`),
      "",
      ...(state.mode === "case" ? ["## 事例の入力に固定した証拠と manifest.md の照合", "", ...(caseMismatches.length > 0 ? caseMismatches.map((m) => `- 不一致: ${m}`) : ["- 一致"]), ""] : []),
      "## acceptance-input/ の各ファイルの sha256（records.md を含む。委譲前の指紋）",
      "",
      "```text",
      fileFingerprint(A).trimEnd(),
      "```",
      "",
      "## 同一性の確認（共通入力・依存の写し・限定 clone）",
      "",
      ...identity.items.map((i) => `- ${i.name}: ${i.ok ? "一致" : "不一致"}（${i.detail}）`),
      "",
    ].join("\n"),
  );
  const outcome = ready ? { status: "準備完了", reason: null } : { status: "未完了", reason: ACCEPTANCE_UNFIXED, score: NOT_RUN_SCORE, merge: NOT_RUN_MERGE };
  const summary = { items: items.length, evidence: n, unavailable: items.filter((i) => i.id.startsWith("evidence/") && !i.obtained).map((i) => ({ id: i.id, code: i.code })) };
  return { work, result: { ready, ...outcome, files, comparison, caseMismatches, identity, ...summary, records: join(A, "records.md"), detail: join(P, "evidence.json") } };
}

// ---- 受け入れ確認の結果の機械検査（parent.md 9節。親は結果の本文を通読しない） ----

const ACCEPTANCE_VERDICTS = ["確認済み", "未充足", "確かめられず"];
const PARTS = ["成果物の不変版の存在", "作業・手順の実施", "現在の配置", "外部の正本との内容の一致", "更新順序"] as const;
const OUT_OF_SCOPE = "対象外";
const ACCEPTANCE_TARGET_FIELDS = ["役割", "定義名", "対象版", "受け取った入力"];
const JUDGMENT_FIELDS = ["要求の出典", "対象版", "判定", ...PARTS, "証拠", "不足理由"];
const GAP_HEADER = ["要求の出典", "判定", "不足箇所", "不足理由"];
const USED_HEADER = ["項目", "出典", "使った行", "使い方"];
const CONFLICT_HEADER = ["反証の判定の箇所", "矛盾する証拠", "理由"];
const CLONE_ITEM = "限定 clone";

// 行ごとの判定の1行（parts は5つの部分ごとの 確認済み・未充足・確かめられず・対象外。candidates は受け入れ確認担当の行の候補 ID）
export interface Judgment {
  source: string;
  verdict: string;
  parts: Record<string, string>;
  evidence: string;
  shortfall: string;
  candidates: string[];
}

// 未充足・確かめられずの行の表の1行
export interface Gap {
  source: string;
  verdict: string;
  missing: string;
  shortfall: string;
}

// 判定に使った証拠の表の1行（item は records.md の項目 ID か「限定 clone」、rows は使った受け入れ確認担当の行の要求の出典）
export interface UsedEvidence {
  item: string;
  source: string;
  rows: string[];
  use: string;
}

// 反証の判定と矛盾する証拠の表の1行（有効な結果。確認が残る事項にする）
export interface Conflict {
  location: string;
  evidence: string;
  reason: string;
}

// check-acceptance に合格した結果から読み取った構造（parent/acceptance-structure.json）。確認が残る事項と保存直前の再照合はこれを読む
export interface AcceptanceStructure {
  attempt: number;
  agentId: string | null;
  file: string;
  sha256: string;
  checkedAt: string;
  judgments: Judgment[];
  gaps: Gap[];
  used: UsedEvidence[];
  conflicts: Conflict[];
}

function acceptanceViolations(text: string, prep: Prepared, rows: AcceptanceRow[], itemIds: Set<string>, add: Add): Pick<AcceptanceStructure, "judgments" | "gaps" | "used" | "conflicts"> {
  const secs = sectionsOf(text.split("\n"), 2);
  const section = (name: string) => secs.find((s) => s.title.startsWith(name));

  // 2: 担当と対象
  targetViolations(section("担当と対象"), ACCEPTANCE_TARGET_FIELDS, "acceptance", prep, 2, add, /完了|確かめられず/);

  // 3・4: 担当全行（rows.md と同じ出典）と、各行の判定・5つの部分・証拠・不足理由
  const rowSection = section("行ごとの判定");
  if (!rowSection) add(4, "「行ごとの判定」の節が無い");
  const sources = new Set(rows.map((r) => r.source));
  const judgments: Judgment[] = [];
  for (const b of sectionsOf(rowSection?.body ?? [], 3)) {
    const f = fieldsOf(b.body);
    const source = norm(f.get("要求の出典") ?? "");
    const missing = JUDGMENT_FIELDS.filter((n) => !plain(f.get(n) ?? ""));
    if (missing.length > 0) add(4, `行「${source || b.title}」の ${missing.join("・")} が無いか空`);
    if (!source) continue;
    if (!sources.has(source)) add(3, `行 ${source} が受け入れ確認担当の行（parent/acceptance/rows.md）に無い`);
    if (judgments.some((j) => j.source === source)) add(3, `行 ${source} が重複している`);
    const verdict = plain(f.get("判定") ?? "");
    if (!ACCEPTANCE_VERDICTS.includes(verdict)) add(4, `行 ${source} の判定「${verdict}」が語彙（${ACCEPTANCE_VERDICTS.join("・")}）に無い`);
    const parts: Record<string, string> = {};
    for (const part of PARTS) {
      const value = plain(f.get(part) ?? "");
      const word = [...ACCEPTANCE_VERDICTS, OUT_OF_SCOPE].find((w) => value.startsWith(w));
      if (value && !word) add(4, `行 ${source} の${part}が「確認済み／未充足／確かめられず」か「対象外（要求が求めていない）」で始まらない`);
      parts[part] = word ?? "";
    }
    const words = Object.values(parts);
    if (verdict === "確認済み" && words.some((w) => w === "未充足" || w === "確かめられず")) add(4, `行 ${source} は確認済みだが、5つの部分に未充足・確かめられずがある（行の判定の不一致）`);
    if (verdict === "未充足" && !words.includes("未充足")) add(4, `行 ${source} は未充足だが、5つの部分に未充足が無い（行の判定の不一致）`);
    if (verdict === "確かめられず" && (words.includes("未充足") || !words.includes("確かめられず"))) add(4, `行 ${source} は確かめられずだが、5つの部分に${words.includes("未充足") ? "未充足がある" : "確かめられずが無い"}（行の判定の不一致）`);
    const shortfall = norm(f.get("不足理由") ?? "");
    if (verdict !== "確認済み" && ACCEPTANCE_VERDICTS.includes(verdict) && (shortfall === "" || NONE.test(shortfall))) add(4, `行 ${source} は${verdict}だが、不足理由が無いか「なし」`);
    judgments.push({ source, verdict, parts, evidence: norm(f.get("証拠") ?? ""), shortfall, candidates: rows.find((r) => r.source === source)?.candidates ?? [] });
  }
  for (const r of rows) if (!judgments.some((j) => j.source === r.source)) add(3, `受け入れ確認担当の行 ${r.source} が行ごとの判定に無い（担当行の欠落）`);

  // 4: 未充足・確かめられずの行の表（行ごとの判定と同じ出典・判定）
  const gapSection = section("未充足・確かめられずの行");
  const gapTable = sectionTable(gapSection, GAP_HEADER);
  if (!gapSection) add(4, "「未充足・確かめられずの行」の節が無い");
  else if (gapTable.rows.length === 0 && !gapTable.none) add(4, `「未充足・確かめられずの行」に雛形の4列（${GAP_HEADER.join("・")}）の表も「なし」の明示も無い`);
  const gaps: Gap[] = [];
  gapTable.rows.forEach((raw, i) => {
    if (raw.length < GAP_HEADER.length) return add(4, `未充足・確かめられずの行の ${i + 1} 行目の列が足りない`);
    const [source = "", verdict = "", missing = "", shortfall = ""] = raw.map(norm);
    const j = judgments.find((x) => x.source === source);
    if (!j) add(4, `未充足・確かめられずの行の ${source || `${i + 1} 行目`} が行ごとの判定に無い`);
    else if (j.verdict !== verdict) add(4, `未充足・確かめられずの行の ${source} の判定「${verdict}」が行ごとの判定「${j.verdict}」と違う（同一行の判定の不一致）`);
    if (gaps.some((g) => g.source === source)) add(4, `未充足・確かめられずの行に ${source} が重複している`);
    if (!PARTS.some((p) => missing.includes(p))) add(4, `未充足・確かめられずの行の ${source} の不足箇所に5つの部分の名前が無い（${missing || "空"}）`);
    if (!shortfall || NONE.test(shortfall)) add(4, `未充足・確かめられずの行の ${source} の不足理由が無いか「なし」`);
    gaps.push({ source, verdict, missing, shortfall });
  });
  for (const j of judgments) if (j.verdict !== "確認済み" && ACCEPTANCE_VERDICTS.includes(j.verdict) && !gaps.some((g) => g.source === j.source)) add(4, `行 ${j.source} は${j.verdict}だが、未充足・確かめられずの行の表に無い`);

  // 5: 判定に使った証拠（records.md の項目 ID か限定 clone、使った行）
  const usedSection = section("判定に使った証拠");
  const usedTable = sectionTable(usedSection, USED_HEADER);
  if (!usedSection) add(5, "「判定に使った証拠」の節が無い");
  else if (usedTable.rows.length === 0 && !usedTable.none) add(5, `「判定に使った証拠」に雛形の4列（${USED_HEADER.join("・")}）の表も「なし」の明示も無い`);
  const used: UsedEvidence[] = [];
  usedTable.rows.forEach((raw, i) => {
    if (raw.length < USED_HEADER.length) return add(5, `判定に使った証拠の ${i + 1} 行目の列が足りない`);
    const [item = "", source = "", rowsCell = "", use = ""] = raw.map(norm);
    const label = item || `${i + 1} 行目`;
    if (!itemIds.has(item) && !item.startsWith(CLONE_ITEM)) add(5, `判定に使った証拠 ${label} が records.md の項目 ID でも「${CLONE_ITEM}」でもない`);
    const usedRows = [...sources].filter((s) => mentions(rowsCell, s));
    if (usedRows.length === 0) add(5, `判定に使った証拠 ${label} の使った行が受け入れ確認担当の行の要求の出典を指していない（${rowsCell || "空"}）`);
    if (!use) add(5, `判定に使った証拠 ${label} の使い方が空`);
    used.push({ item, source, rows: usedRows, use });
  });

  // 5: 反証の判定と矛盾する証拠（有効な報告。形式だけを確かめる）と、判断を見送った事項
  const conflictSection = section("反証の判定と矛盾する証拠");
  const conflictTable = sectionTable(conflictSection, CONFLICT_HEADER);
  if (!conflictSection) add(5, "「反証の判定と矛盾する証拠」の節が無い");
  else if (conflictTable.rows.length === 0 && !conflictTable.none) add(5, `「反証の判定と矛盾する証拠」に雛形の3列（${CONFLICT_HEADER.join("・")}）の表も「なし」の明示も無い`);
  const conflicts: Conflict[] = [];
  conflictTable.rows.forEach((raw, i) => {
    if (raw.length < CONFLICT_HEADER.length) return add(5, `反証の判定と矛盾する証拠の ${i + 1} 行目の列が足りない`);
    const [location = "", evidence = "", reason = ""] = raw.map(norm);
    const empty = CONFLICT_HEADER.filter((_, k) => ![location, evidence, reason][k]);
    if (empty.length > 0) add(5, `反証の判定と矛盾する証拠の ${i + 1} 行目の ${empty.join("・")} が空`);
    conflicts.push({ location, evidence, reason });
  });
  if (!section("判断を見送った事項")?.body.some((l) => l.trim() !== "")) add(5, "「判断を見送った事項」の節が無いか空");
  return { judgments, gaps, used, conflicts };
}

function checkAcceptance(args: string[]): Outcome {
  const o = parseOptions(args, ["work"], []);
  const { work, prep } = loadWork(o);
  const { structure } = passedRefute(work);
  if (!structure.acceptanceRequired) throw new UsageError("受け入れ確認担当の行が0行なので、受け入れ確認の結果は検査しません");
  const r = ROLES.acceptance;
  const attempt = currentAttempt(work, "acceptance");
  const file = `acceptance/${r.output}`;
  const path = join(work, file);
  const violations: Violation[] = [];
  const add: Add = (no, message) => violations.push({ no, message });
  const body = existsSync(path) && lstatSync(path).isFile() ? readFileSync(path) : null;
  const itemIds = new Set((readRecord<CatalogItem[]>(join(work, "parent/acceptance/items.json")) ?? []).map((i) => i.id));
  const parsed = body === null ? null : acceptanceViolations(body.toString("utf8"), prep, structure.acceptanceRows, itemIds, add);
  if (body === null) add(1, `${file} が無い`);
  const identity = checkIdentity(work, "acceptance", `check-acceptance 試行 ${attempt.attempt}`);
  for (const i of identity.items) if (!i.ok) add(6, `${i.name}: ${i.detail}`);
  const names: [number, string][] = [
    [1, `指定したパスに ${r.output} がある`],
    [2, "役割・定義名・対象版・受け取った入力"],
    [3, "parent/acceptance/rows.md のすべての行が同じ要求の出典で行ごとの判定にある（欠落・重複・余分が無い）"],
    [4, "各行の判定の語彙・5つの部分・証拠・不足理由と行の判定の一致、未充足・確かめられずの行の表と行ごとの判定の一致"],
    [5, "判定に使った証拠の表（records.md の項目 ID か限定 clone、使った行）、反証の判定と矛盾する証拠の表、判断を見送った事項"],
    [6, "acceptance-input/ の写し・共通入力・依存の写し・限定 clone の同一性"],
  ];
  const checkedAt = now();
  const record: CheckRecord = {
    stage: "acceptance",
    role: "acceptance",
    roleName: r.name,
    definition: r.definition,
    attempt: attempt.attempt,
    agentId: attempt.agentId,
    file,
    sha256: body === null ? null : sha256(body),
    valid: violations.length === 0,
    items: names.map(([no, name]) => ({ no, name, ok: !violations.some((v) => v.no === no) })),
    violations,
    identity,
    files: fingerprintList(join(work, "acceptance")),
    parent: "1（担当の返答が入力不備・失敗でない）。結果の本文は通読しない",
    checkedAt,
  };
  const list = [...loadList<CheckRecord>(work, "checks"), record];
  saveList(work, "checks", list, renderChecks(list));
  // 構造は、合格した最新の結果からだけ残す
  const structureFile = join(work, "parent/acceptance-structure.json");
  rmSync(structureFile, { force: true });
  if (!record.valid || !parsed || body === null) return { work, result: { ...record, structure: null } };
  const accepted: AcceptanceStructure = { attempt: attempt.attempt, agentId: attempt.agentId, file, sha256: sha256(body), checkedAt, ...parsed };
  writeFileSync(structureFile, `${JSON.stringify(accepted, null, 2)}\n`);
  const counts = { rows: parsed.judgments.length, gaps: parsed.gaps.length, conflicts: parsed.conflicts.length, used: parsed.used.length };
  return { work, result: { ...record, ...counts, structure: "parent/acceptance-structure.json" } };
}

// ---- 最終状態・点数・確認が残る事項・保存直前の再照合・CI・マージ可否（parent.md 10節） ----

type Status = "完了" | "未完了" | "未実施";
const MERGE_OK = "可（人のレビューなしでマージ可）";
const RECHECK_OWNER = "受け入れ確認担当（新しい実行）";
const OWN_LOGS = "parent/acceptance/own-logs.md";
const SEVERITY = ["Critical（致命的）", "Critical（致命的）", "High（高）", "Medium（中）", "Low（低）"];
const ADDITION = "親以外の追記（使用した証拠の有効性を確認できない。親は意味を判断しない）";

// 確認が残る事項の1件（ref は要求の出典または候補 ID、from はどの照合・結果から来たか）
export interface Remaining {
  ref: string;
  owner: string;
  reason: string;
  from: string;
}

function readRecord<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

// 準備完了でなくても読む prepare の記録（未実施の報告にも使う）
function prepareRecord(work: string): Prepared {
  const prep = readRecord<Prepared>(join(work, "parent/prepare.json"));
  if (!prep) throw new UsageError(`prepare の記録（parent/prepare.json）がある作業ディレクトリを --work に指定してください: ${work}`);
  return prep;
}

// 親自身の記録（写しの後に親が Issue へ書いた記録の id。parent.md 3節）。own-logs.md の `- <id>: <内容>` の行
function ownLogIds(work: string): Set<number> {
  const file = join(work, OWN_LOGS);
  return new Set(existsSync(file) ? [...readFileSync(file, "utf8").matchAll(/^- (\d+):/gm)].map((m) => Number(m[1])) : []);
}

function recordOwnLog(work: string, id: number, what: string): void {
  const file = join(work, OWN_LOGS);
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, "# 親自身の記録（Issue へ書いた記録の id）\n\n");
  writeFileSync(file, `- ${id}: ${what}\n`, { flag: "a" });
}

// --own-log <id>: 親（や13節の前に実装を進める親・PM）が写しの後に Issue へ書いた記録の id を、照合の前に own-logs.md へ記録する
function recordOwnLogArgs(work: string, prep: Prepared, o: Options, what: string): number[] {
  const ids = o.many.filter((m) => m.key === "own-log").map((m) => m.value);
  if (ids.length > 0 && !prep.issue) throw new UsageError("--own-log は Issue のあるレビューだけで使います");
  for (const id of ids) if (!/^\d+$/.test(id)) throw new UsageError(`--own-log は記録の id（数字）にしてください: ${id}`);
  for (const id of ids) recordOwnLog(work, Number(id), what);
  return ids.map(Number);
}

interface ReviewState {
  status: Status;
  reason: string | null;
  refute: RefuteStructure | null;
  acceptance: AcceptanceStructure | null;
  acceptanceRequired: boolean;
}

// 最終状態（SKILL.md 6節、parent.md 10節の4）。必要な担当の有効な結果の有無だけで決め、判定の中身・未確認・保存前の変化では変えない
function reviewStatus(work: string, prep: Prepared, notRunReason: string | undefined): ReviewState {
  const agents = loadList<AgentRecord>(work, "agents");
  const retired = loadList<AttemptRecord>(work, "attempts");
  const checks = loadList<CheckRecord>(work, "checks");
  const none: ReviewState = { status: "未実施", reason: null, refute: null, acceptance: null, acceptanceRequired: false };
  if (notRunReason !== undefined && agents.length > 0) throw new UsageError("--not-run-reason は担当を1つも起動しなかったときだけ使います");
  if (!prep.ready) return { ...none, reason: prep.reason ?? "準備できなかった" };
  if (agents.length === 0) return { ...none, reason: notRunReason ? `${notRunReason}（担当を1つも起動しなかった）` : "担当を1つも起動しなかった" };
  const retiredOf = (a: AgentRecord) => retired.find((x) => x.role === a.role && x.attempt === a.attempt);
  const latest = (role: Role) => agents.filter((a) => a.role === role).at(-1);
  for (const role of Object.keys(ROLES) as Role[]) {
    const last = latest(role);
    if (!last || retiredOf(last)) continue;
    if (!last.receivedAt) throw new UsageError(`${last.roleName}の試行 ${last.attempt} の最終返答の受領が記録されていません（終了を待って agent --event received で記録するか、retire-attempt で隔離してから）`);
    const command = role === "refute" ? "check-refute" : role === "acceptance" ? "check-acceptance" : `check-explore --role ${role}`;
    if (!checks.some((c) => c.role === role && c.attempt === last.attempt)) throw new UsageError(`${last.roleName}の試行 ${last.attempt} を検査していません（${command}）`);
  }
  const refute = readRecord<RefuteStructure>(join(work, "parent/refute-structure.json"));
  const accepted = readRecord<AcceptanceStructure>(join(work, "parent/acceptance-structure.json"));
  const valid = (role: Role): boolean => {
    const last = latest(role);
    const check = last && !retiredOf(last) ? checks.filter((c) => c.role === role && c.attempt === last.attempt).at(-1) : undefined;
    if (!last || !check?.valid) return false;
    if (role === "refute") return refute?.attempt === last.attempt && refute.sha256 === check.sha256;
    if (role === "acceptance") return accepted?.attempt === last.attempt && accepted.sha256 === check.sha256;
    return true;
  };
  const missing = (role: Role): string => {
    const name = ROLES[role].name;
    const last = latest(role);
    if (!last) return `有効な結果なし（${name}。起動していない）`;
    const gone = retiredOf(last);
    if (gone) return gone.finalReason ?? `有効な結果なし（${name}。試行 ${last.attempt} を無効として隔離し、委譲し直していない）`;
    return `有効な結果なし（${name}。試行 ${last.attempt} の検査が不合格）`;
  };
  const refuteOk = valid("refute") ? refute : null;
  const acceptanceRequired = refuteOk?.acceptanceRequired ?? false;
  const acceptanceOk = acceptanceRequired && valid("acceptance") ? accepted : null;
  const stop = retired.find((a) => a.failure !== "invalid");
  const explore = (["standards", "spec"] as const).filter((r) => !valid(r)).map(missing);
  const ready = (name: string) => readRecord<{ ready?: boolean }>(join(work, "parent", `${name}.json`))?.ready;
  const reason = stop
    ? (stop.finalReason ?? FAILURES[stop.failure])
    : explore.length > 0
      ? `${explore.join("・")}。反証へ進めず、反証を起動しなかった`
      : ready("refute-input") === false
        ? REFUTE_UNFIXED
        : !refuteOk
          ? missing("refute")
          : acceptanceRequired && ready("acceptance-input") === false
            ? ACCEPTANCE_UNFIXED
            : acceptanceRequired && !acceptanceOk
              ? missing("acceptance")
              : null;
  return { status: reason === null ? "完了" : "未完了", reason, refute: refuteOk, acceptance: acceptanceOk, acceptanceRequired };
}

// 判定本文の未確認と受け入れ確認の結果からの確認が残る事項（parent.md 10節の6）。受け入れ確認担当の行の候補で、確かめる担当を受け入れ確認担当とした
// 未確認の候補は、その行の判定で扱い2件に数えない（確認済みなら残さず、未充足・確かめられずならその行の事項に候補 ID を書き添える）
function verdictRemaining(refute: RefuteStructure | null, acceptance: AcceptanceStructure | null): Remaining[] {
  const out: Remaining[] = [];
  const judged = new Set(acceptance?.judgments.map((j) => j.source) ?? []);
  const absorbed = new Map<string, string[]>();
  for (const u of refute?.unconfirmed ?? []) {
    const row = u.kind === "候補" && u.owner.includes("受け入れ確認担当") ? refute?.acceptanceRows.find((r) => r.candidates.includes(u.ref) && judged.has(r.source)) : undefined;
    if (row) absorbed.set(row.source, [...(absorbed.get(row.source) ?? []), u.ref]);
    else out.push({ ref: u.ref, owner: u.owner, reason: `${u.reason}（${u.kind}、軸 ${u.axis}、不足箇所: ${u.missing}）`, from: "反証の未確認と理由" });
  }
  for (const j of acceptance?.judgments ?? []) {
    if (j.verdict === "確認済み") continue;
    const gap = acceptance?.gaps.find((g) => g.source === j.source);
    const ids = absorbed.get(j.source) ?? [];
    out.push({ ref: j.source, owner: "受け入れ確認担当", reason: `${j.verdict}（不足箇所: ${gap?.missing ?? "不明"}）: ${j.shortfall}${ids.length > 0 ? `（候補 ${ids.join("・")} を含む）` : ""}`, from: "受け入れ確認の結果" });
  }
  for (const c of acceptance?.conflicts ?? []) out.push({ ref: c.location, owner: "人", reason: `受け入れ確認の証拠と反証の判定の矛盾（証拠: ${c.evidence}。理由: ${c.reason}）`, from: "受け入れ確認の結果" });
  return out;
}

interface RequirementsRecheck {
  at: string;
  dir: string;
  compared: string[];
  changed: { path: string; before: string | null; after: string | null }[];
  unavailable: { item: string; reason: string }[];
  note: string | null;
}

// 10節の2（13節の4）: 要求の本文・資料だけを prepare と同じ方法で dir へ取り直し、input/requirements/ と sha256 で比べる（評価用は事例の入力から）
function recheckRequirements(work: string, prep: Prepared, dir: string): RequirementsRecheck {
  mkdirSync(dir, { recursive: true });
  const at = now();
  let note: string | null = null;
  let req: Requirements;
  if (prep.caseDir) {
    const c = caseRequirements(dir, readCase(prep.caseDir));
    req = c.req;
    if (c.mismatches.length > 0) note = `事例の manifest.md と一致しない: ${c.mismatches.join("・")}`;
  } else if (prep.issue) req = issueRequirements(dir, join(dir, "issue-snapshot.json"), prep.repo, prep.issue);
  else req = requestRequirements(dir, prep.repo, prep.requests ?? []);
  const before = new Map(fingerprintList(join(work, "input/requirements")).map((f) => [f.path, f.sha256]));
  const after = new Map(fingerprintList(dir, "issue-snapshot.json").map((f) => [f.path, f.sha256]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed = paths.filter((p) => before.get(p) !== after.get(p)).map((p) => ({ path: `requirements/${p}`, before: before.get(p) ?? null, after: after.get(p) ?? null }));
  return { at, dir, compared: paths.map((p) => `requirements/${p}`), changed, unavailable: req.unavailable, note };
}

interface LocalRecheck {
  at: string;
  dir: string;
  head: string;
  // 変わった写し（土台の HEAD・local/ の各ファイル）と、固定時と今の違い
  changed: { path: string; detail: string }[];
}

// 10節の1: mode: local の土台の HEAD と差分（指定された未追跡ファイルを含む）を同じ方法で取り直し、input/local/ の写しと比べる
function recheckLocal(work: string, prep: Prepared, dir: string): LocalRecheck {
  mkdirSync(dir, { recursive: true });
  const at = now();
  const head = git(prep.repo, "rev-parse", "HEAD").stdout.toString().trim();
  writeFileSync(join(dir, "changes.diff"), git(prep.repo, "--no-optional-locks", "diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD").stdout);
  for (const u of prep.untracked ?? []) {
    const src = join(prep.repo, u);
    let present = true;
    try {
      lstatSync(src);
    } catch {
      present = false;
    }
    if (!present) continue;
    mkdirSync(dirname(join(dir, "untracked", u)), { recursive: true });
    copyTree(src, join(dir, "untracked", u));
  }
  const before = new Map(fingerprintList(join(work, "input/local")).map((f) => [`local/${f.path}`, f.sha256]));
  const after = new Map(fingerprintList(dir).map((f) => [`local/${f.path}`, f.sha256]));
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .filter((p) => before.get(p) !== after.get(p))
    .map((path) => ({ path, detail: `固定時 ${before.get(path) ?? "無い"}、今 ${after.get(path) ?? "無い"}` }));
  if (head !== prep.head) changed.unshift({ path: "土台の HEAD", detail: `固定時 ${prep.head}、今 ${head || "取れない"}` });
  return { at, dir, head, changed };
}

// 固定の後に足された Activity の1件（kept は止めなかった理由）
interface Appended {
  id: string;
  at: string;
  actor: string;
  what: string;
  replyTo: string | null;
  kept: "親自身の記録" | null;
}

// 保存直前の観測1件（rows はその証拠を使った受け入れ確認担当の行）
interface Observation {
  reason: string;
  id: string;
  source: string;
  before: string;
  after: string;
  rows: string[];
}

interface EvidenceRecheck {
  at: string;
  dir: string;
  compared: { id: string; source: string; result: string }[];
  observations: Observation[];
  appended: Appended[];
  events: number;
  usedRows: string[];
}

// 10節の3（13節の4）: 受け入れ確認が判定に使った証拠と、evidence/<n> の参照元だけを固定時と同じ方法で dir へ取り直し、CI の結果を除く前の元の写しと比べる。
// 固定の後に足された Activity は、own-logs.md の id の親自身の記録とイベントを除き、意味で選別せずに親以外の追記として、判定に使った証拠を使ったすべての行に付ける
function recheckEvidence(work: string, prep: Prepared, acc: AcceptanceStructure, dir: string): EvidenceRecheck {
  mkdirSync(dir, { recursive: true });
  const at = now();
  const P = join(work, "parent/acceptance");
  const items = readRecord<CatalogItem[]>(join(P, "items.json")) ?? [];
  const details = readRecord<Json[]>(join(P, "evidence.json")) ?? [];
  const state = readRecord<RecordsState>(join(P, "records.json"));
  const own = ownLogIds(work);
  const log: Command[] = [];
  const compared: EvidenceRecheck["compared"] = [];
  const observations: Observation[] = [];
  const observe = (reason: string, id: string, source: string, before: string, after: string, rows: string[]) => observations.push({ reason, id, source, before, after, rows });
  const usedBy = new Map<string, { source: string; rows: Set<string> }>();
  for (const u of acc.used) {
    const entry = usedBy.get(u.item) ?? { source: u.source, rows: new Set<string>() };
    for (const r of u.rows) entry.rows.add(r);
    usedBy.set(u.item, entry);
  }
  const usedRows = [...new Set(acc.used.flatMap((u) => u.rows))];

  // Issue: Activity と現在リンクされた Document を取り直す
  let current: ActivityItem[] | null = null;
  let linked: string[] = [];
  if (state?.mode === "issue" && prep.issue) {
    const p = run([process.env.NOD_CLI || "nod", "--json", "issue", "show", prep.issue], log);
    writeFileSync(join(dir, "issue-snapshot.json"), p.stdout);
    const shown = parseJson(p) as { activity?: unknown; documents?: unknown } | undefined;
    if (p.code === 0 && Array.isArray(shown?.activity)) {
      current = shown.activity as ActivityItem[];
      linked = (Array.isArray(shown.documents) ? (shown.documents as DocRow[]) : []).map((d) => String(d.id));
    } else observe("取り直せず（失効を含む）", "activity", `Issue ${prep.issue} の Activity`, "固定時の写し", `nod issue show が失敗（${failure(p)}。親以外の追記を確かめられない）`, usedRows);
  }
  const fixedList = readRecord<ActivityItem[]>(join(P, "activity.json")) ?? [];
  const fixed = new Map(flattenActivity(fixedList).map((e) => [e.id, e]));
  const currentById = current ? new Map(flattenActivity(current).map((e) => [e.id, e])) : null;

  const watchActivity = (id: string, label: string, rows: string[]) => {
    const before = fixed.get(id);
    const beforeSha = before ? activitySha(before.item) : "固定時の写しに無い";
    if (!currentById || !before) {
      if (!before) observe("取り直せず（失効を含む）", id, label, beforeSha, "固定時の元の写しに無い", rows);
      compared.push({ id, source: label, result: "取り直せず" });
      return;
    }
    const after = currentById.get(id);
    const found: string[] = [];
    if (!after) {
      observe("証拠の削除", id, label, beforeSha, "無い", rows);
      found.push("削除");
    } else {
      if (activitySha(after.item) !== beforeSha) {
        observe("証拠の訂正", id, label, beforeSha, activitySha(after.item), rows);
        found.push("本文の変化");
      }
      if ((after.item.resolvedAt ?? null) !== (before.item.resolvedAt ?? null)) {
        observe("対応不明（撤回・訂正の可能性。親は意味を判断しない）", id, label, `解決 ${before.item.resolvedAt ?? "なし"}`, `解決 ${after.item.resolvedAt ?? "なし"}`, rows);
        found.push("解決の状態の変化");
      }
    }
    compared.push({ id, source: label, result: found.join("・") || "変化なし" });
  };
  const watchDocument = (docId: string, label: string, rows: string[]) => {
    const id = `document:${docId}`;
    const original = join(P, "documents", `document-${docId}.md`);
    const beforeSha = existsSync(original) ? sha256(readFileSync(original)) : "固定時の写しなし";
    if (state?.mode === "issue" && current && !linked.includes(docId)) {
      observe("証拠の削除", id, label, beforeSha, "Issue からのリンクが外れた", rows);
      compared.push({ id, source: label, result: "リンクが外れた" });
      return;
    }
    const p = run([process.env.NOD_CLI || "nod", "--json", "doc", "show", docId], log);
    const doc = parseJson(p) as { content?: unknown } | undefined;
    if (p.code !== 0 || typeof doc?.content !== "string") {
      observe("取り直せず（失効を含む）", id, label, beforeSha, `nod doc show が失敗（${failure(p)}）`, rows);
      compared.push({ id, source: label, result: "取り直せず" });
      return;
    }
    mkdirSync(join(dir, "documents"), { recursive: true });
    writeFileSync(join(dir, "documents", `document-${docId}.md`), doc.content);
    const afterSha = sha256(doc.content);
    if (afterSha !== beforeSha) observe("証拠の訂正", id, label, beforeSha, afterSha, rows);
    compared.push({ id, source: label, result: afterSha === beforeSha ? "変化なし" : "本文の変化" });
  };
  const watchEvidence = (id: string, label: string, rows: string[]) => {
    const item = items.find((i) => i.id === id);
    const detail = details.find((d) => d.id === id);
    if (!item || !detail) {
      observe("取り直せず（失効を含む）", id, label, "記録なし", "固定時の取得の記録（parent/acceptance/items.json・evidence.json）に無い", rows);
      compared.push({ id, source: label, result: "取り直せず" });
      return;
    }
    if (!item.obtained) {
      compared.push({ id, source: label, result: `固定時に写していない（${item.code}。比べる写しなし）` });
      return;
    }
    const changeReason = item.kind.includes("外部の正本") ? "外部の正本の変化" : "参照された記録（配置先・成果物を含む）の変化";
    const D = join(dir, "evidence", id.slice("evidence/".length));
    const before = item.originals.map((f) => `${f.name} ${f.sha256}`).join("・");
    const diffs: string[] = [];
    if (state?.mode === "case") {
      const src = String(detail.source ?? "");
      if (!existsSync(src)) {
        observe("取り直せず（失効を含む）", id, label, before, "事例の入力に無い", rows);
        compared.push({ id, source: label, result: "取り直せず" });
        return;
      }
      mkdirSync(D, { recursive: true });
      copyFileSync(src, join(D, basename(src)));
    } else {
      const head = (detail.refs as Ref[] | undefined)?.[0];
      const fetched: Fetched = head
        ? fetchEvidence(head, D, { work, prep, linked: state?.linkedDocuments ?? [] }, log)
        : { code: "NO_REF", obtained: false, reason: "固定時の参照の記録が無い", method: "", identity: "", versionMatch: "", facts: {} };
      if (!fetched.obtained) {
        observe(fetched.code === "REVISION_NOT_FOUND" ? "対象版との対応不明" : "取り直せず（失効を含む）", id, label, before, `${fetched.code}: ${fetched.reason}`, rows);
        compared.push({ id, source: label, result: `取り直せず（${fetched.code}）` });
        return;
      }
      const facts = (detail.facts ?? {}) as Json;
      if (head?.type === "url" && facts.finalUrl !== fetched.facts.finalUrl) {
        observe("対象版との対応不明", id, label, `最終の URL ${String(facts.finalUrl)}`, `最終の URL ${String(fetched.facts.finalUrl)}`, rows);
        diffs.push("最終の URL");
      }
      if (head?.type === "git" && facts.commit !== fetched.facts.commit) diffs.push(`revision ${head.revision ?? "HEAD"} が指す commit ${String(facts.commit)} → ${String(fetched.facts.commit)}`);
    }
    // HTTP の応答の見出し（Date など）だけの違いは止めない
    const names = new Set([...item.originals.map((f) => f.name), ...(existsSync(D) ? readdirSync(D) : [])].filter((n) => n !== "headers.txt"));
    for (const name of names) {
      const want = item.originals.find((f) => f.name === name)?.sha256 ?? "固定時に無い";
      const got = existsSync(join(D, name)) ? sha256(readFileSync(join(D, name))) : "無い";
      if (want !== got) diffs.push(`${name} ${want} → ${got}`);
    }
    const contentDiffs = diffs.filter((d) => d !== "最終の URL");
    if (contentDiffs.length > 0) observe(changeReason, id, label, before, contentDiffs.join("・"), rows);
    compared.push({ id, source: label, result: diffs.length > 0 ? diffs.join("・") : "変化なし" });
  };

  for (const [item, u] of usedBy) {
    const rows = [...u.rows];
    const label = `判定に使った証拠 ${item}（${u.source}）`;
    if (item.startsWith(CLONE_ITEM)) compared.push({ id: item, source: label, result: "取り直さない（限定 clone の固定版）" });
    else if (item.startsWith("activity")) watchActivity(item, label, rows);
    else if (item.startsWith("document:")) watchDocument(item.slice("document:".length), label, rows);
    else if (item.startsWith("evidence/")) {
      watchEvidence(item, label, rows);
      // evidence/<n> の参照元（records.md に書いた Activity の項目・Document）
      const refs = (details.find((d) => d.id === item)?.refs as Ref[] | undefined) ?? [];
      for (const from of new Set(refs.map((r) => r.from))) {
        const originLabel = `判定に使った証拠 ${item} の参照元 ${from}`;
        if (/^activity[:@]/.test(from) && state?.mode === "issue") watchActivity(from, originLabel, rows);
        else if (/^document:\d+$/.test(from)) watchDocument(from.slice("document:".length), originLabel, rows);
      }
    }
  }

  // 固定の後に足された Activity（コメント・作業ログ・返信・確認依頼と、固定時の確認依頼への回答）。イベントは追記に含めない
  const appended: Appended[] = [];
  let events = 0;
  if (current) {
    const fixedIds = new Set([...fixed.values()].flatMap((e) => ((e.item.kind ?? "comment") === "comment" && typeof e.item.id === "number" ? [e.item.id] : [])));
    const key = (a: ActivityItem) => JSON.stringify([a.kind, a.at, a.actor, a.kind === "event" ? [a.type, a.data] : a.question]);
    const fixedOthers = new Map(fixedList.filter((a) => a.kind === "event" || a.kind === "question").map((a) => [key(a), a]));
    for (const e of flattenActivity(current)) {
      const a = e.item;
      if (a.kind === "event") {
        if (!fixedOthers.has(key(a))) events += 1;
      } else if (a.kind === "question") {
        const before = fixedOthers.get(key(a));
        if (!before) appended.push({ id: e.id, at: a.at ?? "", actor: a.actor ?? "不明", what: "確認依頼", replyTo: null, kept: null });
        else if ((before.answer ?? null) !== (a.answer ?? null)) appended.push({ id: e.id, at: a.answeredAt ?? a.at ?? "", actor: a.answeredBy ?? a.actor ?? "不明", what: "確認依頼の回答", replyTo: null, kept: null });
      } else if (typeof a.id === "number" && !fixedIds.has(a.id)) {
        const what = a.logKind ? `作業ログ（${a.logKind}）` : e.parent !== null ? "返信" : "コメント";
        appended.push({ id: `activity:${a.id}`, at: a.at ?? "", actor: a.actor ?? "不明", what, replyTo: e.parent !== null ? `activity:${e.parent}` : null, kept: own.has(a.id) ? "親自身の記録" : null });
      }
    }
    for (const x of appended.filter((x) => !x.kept)) observe(ADDITION, x.id, `${x.what}、${x.actor}、${x.at}${x.replyTo ? `、返信先 ${x.replyTo}` : ""}`, "固定時に無い", "固定の後に足された", usedRows);
  }
  const result: EvidenceRecheck = { at, dir, compared, observations, appended, events, usedRows };
  writeFileSync(join(dir, "recheck.json"), `${JSON.stringify({ ...result, commands: log }, null, 2)}\n`);
  return result;
}

// 再照合の観測を確認が残る事項にする（親以外の追記は判定に使った証拠を使ったすべての行、それ以外はその証拠を使った行に付ける）
function recheckRemaining(prefix: string, requirements: RequirementsRecheck | null, local: LocalRecheck | null, evidence: EvidenceRecheck | null): Remaining[] {
  return [
    ...(local?.changed ?? []).map((c) => ({ ref: c.path, owner: "人", reason: `${prefix}: 未コミット変更の土台 HEAD・差分の変化（固定した変更と現在の変更が異なる。${c.detail}）`, from: prefix })),
    ...(requirements?.changed ?? []).map((c) => ({ ref: c.path, owner: "人", reason: `${prefix}: 保存時の要求の変化（現在の要求への適合を確かめていない。固定時 ${c.before ?? "無い"}、取り直し ${c.after ?? "無い"}）`, from: prefix })),
    ...(evidence?.observations ?? []).flatMap((o) =>
      o.rows.map((row) => ({ ref: row, owner: RECHECK_OWNER, reason: `${prefix}: ${o.reason}（${o.id}: ${o.source}。固定時 ${o.before}、取り直し ${o.after}）。この実行では判定し直さない`, from: prefix })),
    ),
  ];
}

// CI の照合の記録（parent/ci/<n>/）
interface CiRecord {
  n: number;
  ran: boolean;
  verdict: string;
  reason: string;
  base: string | null;
  resultHead: string | null;
  observedAt: string | null;
  record: string;
  sha256: string;
  required: { context?: string; appId?: number | null; sources?: string[]; result?: string; runs?: { url?: string | null; conclusion?: string | null }[] }[];
}

// 基点の指定を GitHub のブランチ名にする（ローカルのブランチ名、または remote 名を外した追跡ブランチ名）。解決できなければ null
function ciBranch(prep: Prepared): string | null {
  const ref = git(prep.repo, "rev-parse", "--symbolic-full-name", prep.base).stdout.toString().trim();
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  return /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref)?.[1] ?? null;
}

// 3.3節: 同じディレクトリの ci-checks.ts を1回実行して parent/ci/<n>/ に記録する。skip なら実行せず not-run.md に CI 判定と理由だけを書く
function checkCi(work: string, prep: Prepared, n: number, base: string | null, rules: string, skip: { verdict: string; reason: string } | null): CiRecord {
  const rel = `parent/ci/${n}`;
  const dir = join(work, rel);
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new UsageError(`CI の記録 ${dir} が空ではありません（上書きしない）`);
  const empty = { n, base, resultHead: null, observedAt: null, required: [] };
  if (skip || !base) {
    const why = skip ?? { verdict: "必須のチェックを決められず", reason: `基点の指定 ${prep.base} をブランチ名に解決できない` };
    const body = `# CI の照合をしなかった\n\n- CI 判定: ${why.verdict}\n- 理由: ${why.reason}\n- 記録した時刻: ${now()}\n`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "not-run.md"), body);
    return { ...empty, ran: false, ...why, record: `${rel}/not-run.md`, sha256: sha256(body) };
  }
  const p = exec([process.execPath, join(import.meta.dir, "ci-checks.ts"), "--repo", prep.repo, "--base", base, "--head", prep.head, "--rules", rules, "--out", dir]);
  const file = join(dir, "result.json");
  let result: (Omit<CiRecord, "resultHead"> & { head?: string }) | null = null;
  try {
    result = p.code === 0 && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    result = null;
  }
  if (!result || typeof result.verdict !== "string") {
    const body = `# ci-checks.ts の失敗\n\n- 終了コード: ${p.code ?? "なし"}\n\n## 標準出力\n\n\`\`\`text\n${p.stdout.toString()}\n\`\`\`\n\n## 標準エラー\n\n\`\`\`text\n${p.error ?? p.stderr}\n\`\`\`\n`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ci-checks.log"), body);
    return { ...empty, ran: true, verdict: "取得できず", reason: `ci-checks.ts が判定を返さない（${failure(p)}）`, record: `${rel}/ci-checks.log`, sha256: sha256(body) };
  }
  return {
    n,
    ran: true,
    verdict: result.verdict,
    reason: String(result.reason ?? ""),
    base: typeof result.base === "string" ? result.base : base,
    resultHead: typeof result.head === "string" ? result.head : null,
    observedAt: typeof result.observedAt === "string" ? result.observedAt : null,
    record: `${rel}/result.json`,
    sha256: sha256(readFileSync(file)),
    required: Array.isArray(result.required) ? result.required : [],
  };
}

// 10節の8の4: result.json の head が target.md の head と同じで、CI 判定が成功
const ciPassed = (ci: CiRecord, prep: Prepared) => ci.verdict === "成功" && ci.resultHead === prep.head;

const ciSummary = (ci: CiRecord) =>
  `CI 判定 ${ci.verdict}（${ci.reason}。必須のチェック: ${
    ci.required.map((r) => `${r.context}=${r.result}（出典 ${(r.sources ?? []).join("・")}${(r.runs ?? []).map((x) => `、${x.conclusion ?? "未完了"} ${x.url ?? ""}`.trimEnd()).join("")}）`).join("、") || "なし"
  }）`;

// 現在の head と基点の照合（parent/head-check.md に書き足す）
interface HeadCheck {
  label: string;
  at: string;
  command: string;
  currentHead: string | null;
  currentBase: string | null;
  ciBase: string | null;
  headOk: boolean;
  baseOk: boolean;
  problem: string | null;
}

// 10節の8・11節・13節の1: head を固定した元（PR は gh pr view の headRefOid と baseRefName、ref は git rev-parse と基点の指定）から取り直して比べる
function takeHead(work: string, prep: Prepared, ciBase: string | null, label: string): HeadCheck {
  const at = now();
  const src = prep.headSource;
  let command = "なし";
  let currentHead: string | null = null;
  let currentBase: string | null = null;
  let problem: string | null = null;
  if (src?.kind === "pr") {
    command = `gh pr view ${src.pr} --json headRefOid,baseRefName`;
    const p = exec([process.env.NOD_GH || "gh", "pr", "view", src.pr, "--json", "headRefOid,baseRefName"], { cwd: prep.repo });
    const j = parseJson(p) as { headRefOid?: unknown; baseRefName?: unknown } | undefined;
    if (p.code !== 0 || typeof j?.headRefOid !== "string") problem = `現在の head を取り直せない（${failure(p)}）`;
    else {
      currentHead = j.headRefOid.toLowerCase();
      currentBase = typeof j.baseRefName === "string" ? j.baseRefName : null;
    }
  } else if (src?.kind === "ref") {
    command = `git -C ${prep.repo} rev-parse --verify --quiet ${src.ref}^{commit}`;
    const p = git(prep.repo, "rev-parse", "--verify", "--quiet", `${src.ref}^{commit}`);
    if (p.code !== 0) problem = `現在の head を取り直せない（${src.ref} を解決できない）`;
    else currentHead = p.stdout.toString().trim();
    currentBase = ciBranch(prep);
  } else problem = "現在の head を取り直せない（ref なし: head を SHA だけで固定した）";
  const check: HeadCheck = { label, at, command, currentHead, currentBase, ciBase, headOk: currentHead === prep.head, baseOk: currentBase !== null && currentBase === ciBase, problem };
  const file = join(work, "parent/head-check.md");
  if (!existsSync(file)) writeFileSync(file, "# 現在の head と基点の照合\n\nhead を固定した元（parent/head-source.md）から取り直した現在の head と基点を、固定した head と CI の照合に使った基点と比べた記録。\n\n");
  const lines = [
    `## ${label}（${at}）`,
    "",
    `- コマンド: \`${command}\``,
    `- 固定した head: \`${prep.head}\``,
    `- 現在の head: ${currentHead ? `\`${currentHead}\`（${check.headOk ? "一致" : "不一致"}）` : "取り直せない"}`,
    `- CI の照合に使った基点: ${ciBase ?? "なし（CI を照合していない）"}`,
    `- 現在の基点: ${currentBase ?? "取り直せない"}（${check.baseOk ? "一致" : "不一致"}）`,
    `- 結果: ${problem ?? (check.headOk && check.baseOk ? "一致" : headProblems(check).join("・"))}`,
    "",
  ];
  writeFileSync(file, lines.join("\n"), { flag: "a" });
  return check;
}

// 現在の head と基点の照合で、マージ可否を不可にする理由
function headProblems(h: HeadCheck): string[] {
  if (h.problem) return [h.problem];
  return [
    ...(h.headOk ? [] : [`対象版が現在の head と違う（追加コミット。現在の head ${h.currentHead}）`]),
    ...(h.baseOk ? [] : [`基点が変わった（CI の照合に使った基点 ${h.ciBase ?? "なし"}、現在の基点 ${h.currentBase ?? "取り直せない"}）`]),
  ];
}

interface MergeDecision {
  merge: string;
  blockers: string[];
  // 対応表の「自動チェック担当」「受け入れ確認担当」の行と、マージ可否の判定で満たしたか
  autoRows: string[];
  acceptanceRows: string[];
}

type MergeInput = { status: Status; reason: string | null; score: number | null; refute: RefuteStructure | null; acceptance: AcceptanceStructure | null; remaining: number; ci: CiRecord; head: HeadCheck | null; prep: Prepared };

// 10節の8の 1〜3（CI と現在の head を除くレビューの側の条件）で満たしていない理由。自動チェック担当の行は autoOk のときだけ満たしたことにし、autoNote を理由に添える
function reviewBlockers(m: MergeInput, autoOk: boolean, autoNote: string): string[] {
  const verdicts = new Map(m.acceptance?.judgments.map((j) => [j.source, j.verdict]) ?? []);
  const satisfied = (t: TableRow) => ["充足", "説明", "対象外"].includes(t.status) || (t.status === "自動チェック担当" && autoOk) || (t.status === ACCEPTANCE_STATE && verdicts.get(t.source) === "確認済み");
  const unmet = (m.refute?.table ?? []).filter((t) => !satisfied(t)).map((t) => `${t.source}（${t.status}${t.status === ACCEPTANCE_STATE ? `: ${verdicts.get(t.source) ?? "判定なし"}` : t.status === "自動チェック担当" ? `: ${autoNote}` : ""}）`);
  return [
    ...(m.status === "完了" ? [] : [`最終状態 ${m.status}（理由: ${m.reason}）`]),
    ...(m.score === 5 ? [] : [m.score === null ? "点数なし" : `確定した要対応の点数 ${m.score}`]),
    ...(m.status === "完了" && unmet.length > 0 ? [`対応表に満たしていない行がある: ${unmet.join("、")}`] : []),
    ...(m.remaining > 0 ? [`確認が残る事項 ${m.remaining} 件`] : []),
  ];
}

// 10節の8（13節の6）: 最終状態・点数・対応表・受け入れ確認の結果・確認が残る事項と、同じ head の CI・現在の head と基点から決める。どれも変えない
function decideMerge(m: MergeInput): MergeDecision {
  const ok = ciPassed(m.ci, m.prep);
  const table = m.refute?.table ?? [];
  const verdicts = new Map(m.acceptance?.judgments.map((j) => [j.source, j.verdict]) ?? []);
  const blockers = [
    ...reviewBlockers(m, ok, `CI 判定 ${m.ci.verdict}`),
    ...(ok ? [] : [`CI 判定 ${m.ci.verdict}（${m.ci.reason}${m.ci.resultHead ? `。result.json の head ${m.ci.resultHead} は target.md の head と${m.ci.resultHead === m.prep.head ? "一致" : "不一致"}` : ""}）`]),
    ...(m.head ? headProblems(m.head) : []),
  ];
  return {
    merge: blockers.length === 0 ? MERGE_OK : NOT_RUN_MERGE,
    blockers,
    autoRows: table.filter((t) => t.status === "自動チェック担当").map((t) => `${t.source}（同じ head の CI 判定 ${m.ci.verdict} で${ok ? "満たした" : "満たしていない"}）`),
    acceptanceRows: table.filter((t) => t.status === ACCEPTANCE_STATE).map((t) => `${t.source}（受け入れ確認担当: ${verdicts.get(t.source) ?? "判定なし"}）`),
  };
}

// 評価用の事例の「CI を除いてマージ可」（docs/code-review-evaluation.md の再評価の5）。マージ可否とは別の値で、CI と現在の head は見ない。
// 自動チェック担当の行は、実行の前に run.md で固定した扱い（pass は満たした、block は満たしていないとして数える）を finalize の --auto-check-rows で受ける
export interface ReviewSideMerge {
  autoCheckRows: "pass" | "block";
  merge: string;
  blockers: string[];
}

function reviewSideMerge(m: MergeInput, autoCheckRows: "pass" | "block"): ReviewSideMerge {
  const blockers = reviewBlockers(m, autoCheckRows === "pass", `--auto-check-rows ${autoCheckRows}`);
  return { autoCheckRows, merge: blockers.length === 0 ? "CI を除いてマージ可" : "CI を除いてマージ不可", blockers };
}

// ---- 報告の組み立て（parent.md 11節。結果 report.md と監査 audit.md） ----

interface ReportContext {
  work: string;
  prep: Prepared;
  runId: string;
  mode: "issue" | "request" | "case";
  state: ReviewState;
  score: number | null;
  remaining: Remaining[];
  ci: CiRecord;
  head: HeadCheck | null;
  decision: MergeDecision;
  labelPlan: string;
  requirements: RequirementsRecheck | null;
  local: LocalRecheck | null;
  evidence: EvidenceRecheck | null;
  // 報告に載せる計測（prepare の開始から報告の組み立ての直前まで）と、評価用の事例の CI を除いたレビュー側の判定
  usage: ReportUsage;
  reviewSide: ReviewSideMerge | null;
}

const severityOf = (impact: number | null) => (impact === null ? "影響度なし" : `${SEVERITY[impact] ?? "不明"}、影響度 ${impact}`);
const statusLine = (c: ReportContext) => (c.state.status === "完了" ? "完了" : `${c.state.status}（理由: ${c.state.reason}）`);

// 印の間（行単位。awk '/begin/{f=1;next} /end/{f=0} f' と同じ）
function between(text: string, name: string): string | null {
  const lines = text.split("\n");
  const b = lines.indexOf(`<!-- ${name}:begin -->`);
  const e = b < 0 ? -1 : lines.indexOf(`<!-- ${name}:end -->`, b + 1);
  return e < 0 ? null : lines.slice(b + 1, e).map((l) => `${l}\n`).join("");
}

// 担当の申告したモデル（担当と対象の節の「モデル申告」）
function declaredModel(path: string): string {
  if (!existsSync(path)) return "未確認（出力なし）";
  const target = sectionsOf(readFileSync(path, "utf8").split("\n"), 2).find((s) => s.title.startsWith("担当と対象"));
  return `${plain(fieldsOf(target?.body ?? []).get("モデル申告") ?? "") || "未確認"}（出典: ${basename(dirname(path))}/${basename(path)} の担当と対象）`;
}

const fileSha = (path: string) => (existsSync(path) && lstatSync(path).isFile() ? sha256(readFileSync(path)) : "無い");

function renderAudit(c: ReportContext): string {
  const { work, prep, state, ci, decision } = c;
  const W = (rel: string) => `\`${join(work, rel)}\``;
  const agents = loadList<AgentRecord>(work, "agents");
  const retired = loadList<AttemptRecord>(work, "attempts");
  const checks = loadList<CheckRecord>(work, "checks");
  const identities = loadList<Identity>(work, "identity");
  const deps = prep.deps;
  const refute = state.refute;
  const records = readRecord<RecordsState>(join(work, "parent/acceptance/records.json"));
  const accInput = readRecord<{ ready?: boolean; unavailable?: { id: string; code: string }[] }>(join(work, "parent/acceptance-input.json"));
  const required = refute?.required ?? [];
  const impacts = required.map((r) => `${r.heading}（${r.ids.join("・")}）: ${r.impact}`);
  const scoreCalc =
    c.score === null
      ? `${state.status}のため点数なし。`
      : `要対応 ${required.length} 件（${impacts.join("、") || "なし"}）。最も重い影響度（最小値）で ${c.score}${required.length === 0 ? "（要対応0件なので 5）" : ""}。`;
  const verdictFile = join(work, "refute/verdict.md");
  const resultFile = join(work, "acceptance/result.md");
  const verdictText = refute && existsSync(verdictFile) ? readFileSync(verdictFile, "utf8") : null;
  const resultText = state.acceptance && existsSync(resultFile) ? readFileSync(resultFile, "utf8") : null;
  const embed = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);
  const noResult = !state.acceptanceRequired && refute ? "受け入れ確認担当の行なし（起動せず）\n" : `未受領（${state.reason ?? "受け入れ確認の有効な結果なし"}）\n`;
  const manifestRows = new Map(
    [...(existsSync(join(work, "input/manifest.md")) ? readFileSync(join(work, "input/manifest.md"), "utf8") : "").matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \| (.*) \|$/gm)].map((m) => [m[1] ?? "", { sha: m[2] ?? "", source: m[3] ?? "" }]),
  );
  const ev = c.evidence;
  const roleRow = (role: Role) => {
    const r = ROLES[role];
    const list = agents.filter((a) => a.role === role);
    const last = list.at(-1);
    const check = last ? checks.filter((x) => x.role === role && x.attempt === last.attempt).at(-1) : undefined;
    const valid = role === "refute" ? !!refute : role === "acceptance" ? !!state.acceptance : !!check?.valid && !retired.some((a) => a.role === role && a.attempt === last?.attempt);
    const outputPath = join(work, role, r.output);
    const end = !last ? (role === "acceptance" && refute && !state.acceptanceRequired ? "起動せず（受け入れ確認担当の行なし）" : "起動せず") : valid ? "有効な結果を受領" : "有効な結果なし";
    return `| ${r.name} | ${r.definition} | ${cell(valid ? (last?.agentId ?? "不明") : "なし")} | ${last ? `${last.attempt}${last.attempt > 1 ? "（再委譲）" : ""}` : "なし"} | ${end} | ${check ? `${check.valid ? "合格" : "不合格"}（sha256 ${check.sha256 ?? "なし"}）` : "検査なし"} | ${cell(valid ? declaredModel(outputPath) : "未確認")} |`;
  };
  const attemptRows = agents.map((a) => {
    const gone = retired.find((x) => x.role === a.role && x.attempt === a.attempt);
    const check = checks.filter((x) => x.role === a.role && x.attempt === a.attempt).at(-1);
    const result = gone ? (gone.failure === "invalid" ? "無効" : gone.failureLabel) : check?.valid ? "有効" : check ? "不合格（隔離していない）" : "未検査";
    const saved = gone ? `\`${gone.movedTo}\`（${gone.files.map((f) => `${f.path} ${f.sha256}`).join("・") || "ファイルなし"}）` : `\`${join(work, a.role)}\``;
    const redelegate = gone ? (gone.redelegate ? "した／してよい（同じ入力・新しいコンテキストへ1回）" : `しない（${gone.finalReason}）`) : "なし";
    const same = gone ? (gone.identity.ok ? "一致" : `不一致（${gone.identity.items.filter((i) => !i.ok).map((i) => i.detail).join("・")}）`) : "対象外";
    return `| ${a.roleName} | ${a.attempt} | ${cell(a.agentId ?? "不明")} | ${result} | ${cell(gone?.reason ?? "なし")} | ${cell(saved)} | ${cell(gone?.retries ?? "記録なし")} | ${cell(redelegate)} | ${cell(same)} |`;
  });
  const originals: [string, string][] = [
    ["共通入力の目録", "input/manifest.md"],
    ["限定 clone の確認の記録", "parent/clone.md"],
    ["依存の写しの指紋の一覧", "input/deps-files.sha256"],
    ["Standards 探索の引き渡し用ファイル", "standards/handoff.md"],
    ["Standards 探索の引き渡し用ファイル（反証への写し）", "refute-input/standards-handoff.md"],
    ["Spec 探索の引き渡し用ファイル", "spec/handoff.md"],
    ["Spec 探索の引き渡し用ファイル（反証への写し）", "refute-input/spec-handoff.md"],
    ["反証の判定本文", "refute/verdict.md"],
    ["反証の判定本文（受け入れ確認への写し）", "acceptance-input/refute-verdict.md"],
    ["受け入れ確認への写しの目録", "acceptance-input/records.md"],
    ["受け入れ確認への入力の指紋", "parent/acceptance/fingerprints.md"],
    ["受け入れ確認の結果", "acceptance/result.md"],
    ["保存直前の受け入れ証拠の取り直し", "parent/acceptance-recheck/recheck.json"],
    ["親の検査記録", "parent/checks.md"],
    ["反証への入力の指紋", "parent/fingerprints.md"],
    ["試行の記録", "parent/agents.md"],
    ["無効な試行の記録", "parent/attempts.md"],
    ["CI の照合の記録", ci.record],
    ["head を固定した元", "parent/head-source.md"],
    ["現在の head の照合", "parent/head-check.md"],
  ];
  const ciBlock = ci.ran
    ? [
        `- CI 判定: ${ci.verdict}（${ci.reason}）${ci.verdict === "成功" ? "" : "。成功以外はマージ不可"}`,
        `- 必須のチェックと出典: ${ci.required.map((r) => `${r.context}（app の指定 ${r.appId ?? "なし"}。出典: ${(r.sources ?? []).join("・")}）`).join("、") || "なし"}（出典ごとの読めた／0件／決められず と理由は result.json の sources）`,
        `- 必須のチェックごとの結果: ${ci.required.map((r) => `${r.context}=${r.result}${(r.runs ?? []).map((x) => `（${x.conclusion ?? "未完了"} ${x.url ?? ""}）`).join("")}`).join("、") || "なし"}`,
        `- head SHA の一致: result.json の head ${ci.resultHead ?? "なし"} と target.md の head ${prep.head} が${ci.resultHead === prep.head ? "一致" : "不一致"}`,
        `- 観測時刻: ${ci.observedAt ?? "なし"}（CI の完了を待たず、この時点の結果で判定した）`,
        `- 記録: ${W(ci.record)}（sha256 ${ci.sha256}。gh の生の応答の sha256 は result.json の files）`,
      ]
    : [`- CI 判定: ${ci.verdict}（照合しなかった。理由: ${ci.reason}）`, `- 記録: ${W(ci.record)}（sha256 ${ci.sha256}）`];
  const headLine = c.head
    ? `- 現在の head と基点の照合: ${c.head.problem ?? `現在の head ${c.head.currentHead}（${c.head.headOk ? "固定した head と一致" : "不一致。対象版が現在の head と違う（追加コミット）"}）、現在の基点 ${c.head.currentBase ?? "取り直せない"}（CI の照合に使った基点 ${c.head.ciBase ?? "なし"} と${c.head.baseOk ? "一致" : "不一致。基点が変わった"}）`}。取得: \`${c.head.command}\`（${c.head.at}）。記録: ${W("parent/head-check.md")}`
    : `- 現在の head と基点の照合: 照合せず（${state.status === "未実施" ? "未実施" : prep.caseDir ? "評価用の事例" : "mode: local"}）`;
  const followUp =
    state.status === "完了"
      ? `確定した要対応の点数 ${c.score}、要対応 ${required.length} 件、確認が残る事項 ${c.remaining.length} 件。${c.remaining.length > 0 ? "完了でも確認が残る事項は、提出・完了に必要な確認の不足として既存の提出・完了条件へ委ねる。" : ""}マージ可否と CI の結果に触れる部分は、次の ci-result の印の中だけに書く。`
      : `独立レビュー${state.status}（${state.reason}）。試行の記録と受領済みの成果は上の担当と試行の記録の節。Done・In Review・PR へ進めない（委譲し直しや利用枠の回復待ちで代替しない）。マージ可否と CI の結果に触れる部分は、次の ci-result の印の中だけに書く。`;
  const reqRows = prep.inputs.filter((i) => i.path.startsWith("requirements/"));
  return [
    "この記録は監査記録専用。利用者向けの結果は別の結果 Document にまとめ、同じ runId・対象 SHA で対応付ける。review.ts finalize が作業ディレクトリの記録から組み立てた。",
    "",
    "## 管理情報（親が記入）",
    "",
    `- runId: ${c.runId}`,
    `- 作業ディレクトリ: ${work}`,
    `- 最終状態: ${statusLine(c)}`,
    `- 確定した要対応の点数: ${c.score ?? NOT_RUN_SCORE}`,
    `- 点数の計算: ${scoreCalc}未確認が残っていても完了なら計算し、軸間で平均せず、任意・棄却・基点から存在（対象外）・未確認は入れない。点数は確定した要対応の影響度だけを表し、要求の確認率もマージ許可も表さない。CI の結果では状態・点数を変えない。`,
    `- 確認が残る事項: ${c.remaining.length} 件（下の「確認が残る事項」の節）。最終状態と点数を変えず、マージ可否だけを止める。`,
    "- マージ可否・現在の head の照合・merge-ready: CI の結果を含むので、次の ci-result の印の中だけに書く（後のレビューの受け入れ確認への写しでは、親が印の中を除く）",
    CI_BEGIN,
    `- マージ可否: ${decision.merge}`,
    ...(decision.blockers.length > 0 ? [`  - 不可の理由: ${decision.blockers.join("／")}`] : []),
    `  - 対応表の「自動チェック担当」の行: ${decision.autoRows.join("、") || "なし"}（対応表と点数の対象外という扱いは変えない）`,
    `  - 対応表の「受け入れ確認担当」の行: ${decision.acceptanceRows.join("、") || (refute ? "なし（受け入れ確認担当は起動せず）" : "なし（反証の有効な結果なし）")}（確認済みの行だけをマージ可否の判定で満たしたことにする）`,
    "  - 「完了・確定した要対応の点数 5・確認が残る事項あり・マージ不可」は正常な結果である。可でもリポジトリの既存のマージ条件（ブランチ保護・必須のレビューなど）は省かない。",
    headLine,
    `- merge-ready: ${c.labelPlan}。報告の保存と作業ログの直後に行う操作として書く。ラベルは現在の判定の表示で、自動マージの指示ではない。操作の結果は、判定した head SHA・現在の head の照合・基点・CI 判定・この報告の Document ID・runId とともに、本文が [ci-result] で始まる --kind test の作業ログに記録する`,
    ...(c.reviewSide
      ? [
          `- CI を除いたレビュー側の判定（評価用）: ${c.reviewSide.merge}（マージ可否とは別の値。CI と現在の head を見ず、自動チェック担当の行は --auto-check-rows ${c.reviewSide.autoCheckRows} の扱い（${c.reviewSide.autoCheckRows === "pass" ? "満たした" : "満たしていない"}として数える）${c.reviewSide.blockers.length > 0 ? `。理由: ${c.reviewSide.blockers.join("／")}` : ""}）`,
        ]
      : []),
    CI_END,
    `- 対象版: 元のリポジトリ \`${prep.repo}\`／基点の指定 \`${prep.base}\`／merge-base \`${prep.mergeBase}\`／head \`${prep.head}\`／mode ${prep.mode}${prep.mode === "local" ? `（土台の HEAD \`${prep.head}\`、${prep.inputs.filter((i) => i.path.startsWith("local/")).map((i) => `\`${i.path}\` ${i.sha256}`).join("・")}）` : ""}${prep.caseDir ? `／評価用の事例 ${prep.case}` : ""}`,
    `- 担当用の限定 clone: ${W("repo")}（記録: ${W("parent/clone.md")}）。prepare の確認: ${prep.clone ? (prep.clone.checks.every((x) => x.ok) ? "すべて通った" : "通らない確認がある") : "作っていない"}。段階ごとの同一性の確認 ${identities.length} 回（不一致 ${identities.filter((i) => !i.ok).length} 回。記録: ${W("parent/identity.md")}）`,
    `- 依存の写し: ${
      deps?.prepared
        ? `${W("deps/")}、lockfile \`${deps.lockfile}\`（sha256 ${deps.lockfileSha256}）、${deps.manager} ${deps.version}、準備のコマンド \`${deps.command}\`（終了コード ${deps.exitCode}）、取得元 ${deps.registry}、指紋の一覧 \`input/deps-files.sha256\`（sha256 ${fileSha(join(work, "input/deps-files.sha256"))}、ファイル ${deps.files} 件・リンク ${deps.links} 件）`
        : `依存の写しなし（${deps?.reason ?? "準備していない"}）`
    }`,
    `- 受け入れ確認への写し: ${
      records
        ? `${W("acceptance-input/")}、目録 records.md の sha256 ${fileSha(join(work, "acceptance-input/records.md"))}、Activity と添付 Document の取得 ${records.takenAt}、CI の結果の除外 ${records.exclusions.length} 件（目録の除外の表）、取得不能 ${(accInput?.unavailable ?? []).map((u) => `${u.id}（${u.code}）`).join("・") || "なし"}、入力の固定 ${accInput?.ready ? "一致" : "固定できず"}。元の写しと取得の記録は ${W("parent/acceptance/")}（items.json・evidence.json・records.json・fingerprints.md）。探索・反証の担当へは渡していない`
        : refute && !state.acceptanceRequired
          ? "受け入れ確認担当の行なし（写さず）"
          : "写していない"
    }`,
    `- 未コミット変更の差分確認: ${c.local ? `${c.local.at} に土台の HEAD ${c.local.head} と差分を取り直した（${W("parent/local-recheck/")}）。${c.local.changed.length > 0 ? `変化あり: ${c.local.changed.map((x) => `${x.path}（${x.detail}）`).join("・")}（確認が残る事項に入れた）` : "変化なし"}` : "対象外（mode: commit）"}`,
    "",
    "### 確認が残る事項",
    "",
    "判定本文の未確認、受け入れ確認の未充足・確かめられず、要求間の矛盾、受け入れ確認の証拠と反証の判定の矛盾、保存時の要求の変化、保存直前の受け入れ証拠の再照合で見つかった事項、未コミット変更の土台 HEAD・差分の変化を、例外なくすべて載せる。",
    "",
    ...(c.remaining.length > 0 ? ["| 要求の出典（または候補 ID） | 確かめる担当 | 理由 |", "|---|---|---|", ...c.remaining.map((r) => `| ${cell(r.ref)} | ${cell(r.owner)} | ${cell(r.reason)} |`)] : ["なし"]),
    "",
    "### CI の結果（親だけが照合）",
    "",
    "CI の結果は次の ci-result の印の中だけに書く。",
    "",
    CI_BEGIN,
    "親はテストを実行せず、同じ head SHA に対する CI の結果を GitHub から読むだけにした（scripts/ci-checks.ts）。CI の結果はレビュー担当へ渡していない。",
    "",
    ...ciBlock,
    CI_END,
    "",
    "### 要求の出典と写しの指紋",
    "",
    "| 写し | 出典 | sha256 |",
    "|---|---|---|",
    ...reqRows.map((i) => `| \`${i.path}\` | ${manifestRows.get(i.path)?.source ?? "manifest.md に無い"} | ${i.sha256} |`),
    "",
    `取得できなかった資料と理由: ${((prep as Prepared & { unavailable?: { item: string; reason: string }[] }).unavailable ?? []).map((u) => `${u.item}: ${u.reason}`).join("・") || "なし"}`,
    "",
    "### 保存時の要求変化の確認",
    "",
    c.requirements
      ? `${c.requirements.at} に ${W("parent/requirements-recheck/")} へ取り直し、${c.requirements.compared.join("・") || "なし"} を input/requirements/ と sha256 で比べた。${
          c.requirements.changed.length > 0 ? `変化あり: ${c.requirements.changed.map((x) => `${x.path}（固定時 ${x.before ?? "無い"}、取り直し ${x.after ?? "無い"}）`).join("・")}。この結果は旧要求に対するもので、現在の要求への適合は確かめていない（確認が残る事項に入れた）。` : "変化なし。"
        }${c.requirements.unavailable.length > 0 ? `取り直せなかった資料: ${c.requirements.unavailable.map((u) => `${u.item}: ${u.reason}`).join("・")}。` : ""}${c.requirements.note ? c.requirements.note : ""}`
      : "取り直していない（未実施）",
    "",
    "### 保存直前の受け入れ証拠の再照合",
    "",
    ...(ev
      ? [
          `- 取り直した時刻: ${ev.at}（記録: ${W("parent/acceptance-recheck/")}）`,
          "- 比べた証拠（結果の「判定に使った証拠」の項目と、evidence/<n> の参照元）と結果:",
          "",
          "| 項目 | 何と比べたか | 結果 |",
          "|---|---|---|",
          ...ev.compared.map((x) => `| ${cell(x.id)} | ${cell(x.source)} | ${cell(x.result)} |`),
          "",
          `- 固定の後に足された Activity: ${ev.appended.length} 件。親以外の追記 ${ev.appended.filter((x) => !x.kept).length} 件${ev.appended.some((x) => !x.kept) ? `（${ev.appended.filter((x) => !x.kept).map((x) => `${x.id}（${x.what}、${x.actor}、${x.at}${x.replyTo ? `、返信先 ${x.replyTo}` : ""}）`).join("、")}。どれも確認が残る事項にした）` : ""}。止めなかった親自身の記録 ${ev.appended.filter((x) => x.kept).length} 件（${OWN_LOGS} の id）、Issue のイベント ${ev.events} 件`,
          "- 親以外の追記は種類・書いた人・返信先・本文を問わず確認が残る事項にし、本文の意味では選別していない。親自身の記録かどうかは書いた人ではなく own-logs の id で決めた。",
          "- 変化があっても、この実行では新しい証拠へ差し替えて判定し直さず、担当の判定本文・最終状態・点数を変えていない。この再照合は観測時点までの確認であり、将来の配置状態は保証しない。",
        ]
      : [`対象なし（${state.acceptance ? "取り直していない" : state.acceptanceRequired ? "受け入れ確認担当の有効な結果なし" : "受け入れ確認担当を起動していない"}）`]),
    "",
    "### 担当",
    "",
    "| 役割 | 定義名 | 担当 ID（有効な結果の担当） | 試行 | 終了状態 | 引き渡しの検査 | モデル申告と出典 |",
    "|---|---|---|---|---|---|---|",
    ...(["standards", "spec", "refute", "acceptance"] as const).map(roleRow),
    "",
    "- 実装者との対応: 各担当はこのレビューの委譲で起動した別の担当である。ID の違いだけで会話を引き継いでいないことの証明とは扱わない。",
    "- モデル情報は申告と出典だけで、不明は未確認とする。実効モデルの証明ではない。",
    "",
    "### 試行の記録",
    "",
    `起動したすべての試行（記録: ${W("parent/agents.md")}・${W("parent/attempts.md")}）。無効だった試行の出力は後続の担当へ渡さず ${W("parent/attempts/")} に残した。「omp 内部の再試行」は担当のセッションの中でハーネスが行った retry で、親による再委譲とは別に書く。`,
    "",
    "| 役割 | 試行 | 担当 ID | 結果 | 無効の理由 | 保存場所と sha256 | omp 内部の再試行 | 親による再委譲 | 同じ入力の確認 |",
    "|---|---|---|---|---|---|---|---|---|",
    ...attemptRows,
    "",
    "### 原本の場所と指紋",
    "",
    "| 原本 | 場所 | sha256 |",
    "|---|---|---|",
    ...originals.filter(([, rel]) => existsSync(join(work, rel))).map(([name, rel]) => `| ${name} | ${W(rel)} | ${fileSha(join(work, rel))} |`),
    "",
    "### 後続判断",
    "",
    followUp,
    "",
    CI_BEGIN,
    `マージ可否は${decision.merge}。${decision.merge === MERGE_OK ? "" : "人の判断なしにマージへ進めない。"}${ci.verdict === "未確定" || ci.verdict === "結果なし" ? "CI の完了後に親の手順の13節の CI の再照合（review.ts recheck-ci）で判定し直す（レビューはやり直さない）。" : ""}`,
    CI_END,
    "",
    ...renderAuditUsage(c.usage, work),
    "",
    "### 独立性の限界",
    "",
    "探索と反証は別コンテキストで実行し、探索には異なるモデルを設定するが、見落としが共通する可能性は残り、設定だけで各実行の実効モデルの違いを証明するものではない。各担当のモデルは上の担当の表の申告と出典だけで、スクリプトはハーネスのロール設定を読まない（分からなければ未確認）。",
    "",
    "## 反証担当の判定本文（原文のまま）",
    "",
    `- 原本: ${verdictText !== null ? W("refute/verdict.md") : "未受領"}`,
    `- sha256: ${refute?.sha256 ?? "なし"}（check-refute で検査した指紋）`,
    `- 担当 ID: ${refute?.agentId ?? "なし"}`,
    "",
    "<!-- refute-verdict:begin -->",
    `${verdictText !== null ? embed(verdictText) : `未受領（${state.reason ?? "反証の有効な結果なし"}）\n`}<!-- refute-verdict:end -->`,
    "",
    "## 受け入れ確認担当の結果（原文のまま）",
    "",
    `- 原本: ${resultText !== null ? W("acceptance/result.md") : "未受領"}`,
    `- sha256: ${state.acceptance?.sha256 ?? "なし"}（check-acceptance で検査した指紋）`,
    `- 担当 ID: ${state.acceptance?.agentId ?? "なし"}`,
    "",
    "受け入れ確認の結果は、反証の判定本文と点数を変えない。",
    "",
    "<!-- acceptance-result:begin -->",
    `${resultText !== null ? embed(resultText) : noResult}<!-- acceptance-result:end -->`,
    "",
  ].join("\n");
}

function renderReport(c: ReportContext, auditRef: string): string {
  const required = c.state.refute?.required ?? [];
  return [
    "## 結果",
    "",
    `- 最終状態: ${statusLine(c)}`,
    `- 確定した要対応の点数: ${c.score ?? NOT_RUN_SCORE}`,
    `- 確認が残る事項: ${c.remaining.length} 件`,
    `- 対象: ${c.prep.head}（基点 ${c.prep.base}、merge-base ${c.prep.mergeBase}、mode ${c.prep.mode}）`,
    CI_BEGIN,
    `- マージ可否: ${c.decision.merge}`,
    ...(c.decision.blockers.length > 0 ? [`- 理由: ${c.decision.blockers.join("／")}`] : []),
    `- CI 判定: ${c.ci.verdict}`,
    `- merge-ready: ${c.labelPlan}。実際の操作結果は保存後の [ci-result] の作業ログを参照`,
    CI_END,
    "",
    "## 要対応",
    "",
    ...(required.length > 0
      ? [
          "| ID | Severity（影響度） | 問題 | 影響 | 場所 |",
          "|---|---|---|---|---|",
          ...[...required].sort((a, b) => (a.impact ?? 5) - (b.impact ?? 5)).map((r) => `| ${cell(`${r.heading}${r.heading.startsWith("CAUSE-") ? `（${r.ids.join("・")}）` : ""}`)} | ${severityOf(r.impact)} | ${cell(r.title)} | ${cell(r.effect)} | ${cell(r.location)} |`),
          "",
          "Severity は共通規則の影響度から機械的に表示する: 0・1=Critical、2=High、3=Medium、4=Low。",
        ]
      : [c.state.refute ? "なし" : "なし（反証の有効な結果なし）"]),
    "",
    "## 未確認",
    "",
    ...(c.remaining.length > 0 ? ["| 出典 | 確認する人・担当 | 不足している確認 |", "|---|---|---|", ...c.remaining.map((r) => `| ${cell(r.ref)} | ${cell(r.owner)} | ${cell(r.reason)} |`)] : ["なし"]),
    "",
    ...renderReportUsage(c.usage),
    "",
    "## 監査記録",
    "",
    `- ${auditRef}`,
    `- runId: ${c.runId}`,
    "",
    "全対応表・担当別の原文・指紋・取得と再照合・担当と試行の記録・CI の詳細は監査記録にある。",
    "",
  ].join("\n");
}

// ---- 保存・作業ログ・merge-ready（parent.md 11節・13節） ----

interface SavedDocument {
  id: number | null;
  path: string | null;
  title: string;
  problems: string[];
}

// kind=doc の Document として Issue に保存し、読み直して kind・Issue のリンク・タイトル見出しを除いた本文と原稿の同一性・印の間の指紋を確かめる
function saveDocument(issue: string, name: string, title: string, text: string, markers: { name: string; sha256: string | null }[]): SavedDocument {
  const p = nod(["--json", "doc", "create", name, "--title", title, "--kind", "doc", "--issue", issue, "--body", "-"], text);
  const created = parseJson(p) as { id?: unknown; path?: unknown } | undefined;
  if (p.code !== 0 || typeof created?.id !== "number") return { id: null, path: null, title, problems: [`${title} の保存に失敗（${failure(p)}）`] };
  const problems: string[] = [];
  const shown = nod(["--json", "doc", "show", String(created.id)]);
  const doc = parseJson(shown) as { kind?: unknown; issues?: { id?: unknown }[]; content?: unknown } | undefined;
  if (shown.code !== 0 || typeof doc?.content !== "string") problems.push(`${title}（Document ${created.id}）を読み直せない（${failure(shown)}）`);
  else {
    if (doc.kind !== "doc") problems.push(`${title}（Document ${created.id}）の kind が doc でない（${String(doc.kind)}）`);
    if (!(doc.issues ?? []).some((i) => String(i.id).toUpperCase() === issue.toUpperCase())) problems.push(`${title}（Document ${created.id}）が Issue ${issue} にリンクされていない`);
    const heading = `# ${title}\n\n`;
    const body = doc.content.startsWith(heading) ? doc.content.slice(heading.length) : null;
    if (body === null || body !== text) problems.push(`${title}（Document ${created.id}）のタイトル見出しを除いた本文が原稿と違う（原稿 ${sha256(text)}、保存 ${body === null ? "タイトル見出しが違う" : sha256(body)}）`);
    problems.push(...markerProblems(doc.content, markers, `${title}（Document ${created.id}）`));
  }
  return { id: created.id, path: String(created.path ?? ""), title, problems };
}

// 監査の印の間（反証の判定本文・受け入れ確認の結果）の指紋を、検査した原本の指紋と比べる
function markerProblems(text: string, markers: { name: string; sha256: string | null }[], where: string): string[] {
  return markers.flatMap((m) => {
    if (!m.sha256) return [];
    const got = between(text, m.name);
    return got !== null && sha256(got) === m.sha256 ? [] : [`${where} の ${m.name} の印の間の指紋が検査した原本と違う（原本 ${m.sha256}、印の間 ${got === null ? "印が無い" : sha256(got)}）`];
  });
}

function issueLabels(issue: string): string[] | null {
  const p = nod(["--json", "issue", "show", issue]);
  const j = parseJson(p) as { labels?: unknown } | undefined;
  return p.code === 0 && Array.isArray(j?.labels) ? j.labels.map(String) : null;
}

interface LabelResult {
  operation: "付けた" | "外した" | "付けていない" | "付けられなかった" | "外せなかった";
  blockers: string[];
  head: HeadCheck | null;
  error: string | null;
  log: number | null;
}

// ---- 作業ログ（nod issue log）の上限 ----

// nod の作業ログの上限（packages/core/src/work-log.ts の WORK_LOG_MAX_LENGTH。workLogLength と同じくコードポイントで数える）。超えると nod が INVALID_ARGS で拒否する
const WORK_LOG_MAX = 4000;
// 収まらない項目を途中まで書くのは、この字数以上を書けるときだけ
const WORK_LOG_MIN_CUT = 20;

// 作業ログの一覧の部分（項目を「、」でつなぐ）。収まらない項目は書かず、件数と全文の場所 more を書く
interface LogList {
  open: string;
  items: string[];
  close: string;
  more: string;
}

// 一覧が空なら empty の文にする
function logList(open: string, items: string[], close: string, more: string, empty = ""): string | LogList {
  return items.length > 0 ? { open, items, close, more } : empty;
}

// parent.md 11節・13節: 作業ログを nod の上限に決定的に収める。文字列の部分（必須の項目）はそのまま残し、一覧は1件ずつ順に（どれも先頭から）
// 丸ごと入るだけ書いて、書けなかった件数と全文の場所を「ほか N 件は<場所>を参照」と書く。丸ごと入らない次の項目は残りの字数で途中まで書いて切ったことを示す。
// 必須の項目だけで上限を超えるときは末尾を切ってその旨を書く
function fitWorkLog(parts: (string | LogList)[]): string {
  const lists = parts.flatMap((p) => (typeof p === "string" ? [] : [{ list: p, shown: 0, cut: null as string | null, full: false }]));
  const render = () =>
    parts
      .map((p) => {
        const s = lists.find((l) => l.list === p);
        if (typeof p === "string" || !s) return p;
        const rest = p.items.length - s.shown - (s.cut === null ? 0 : 1);
        const items = [...p.items.slice(0, s.shown), ...(s.cut === null ? [] : [s.cut]), ...(rest > 0 ? [`ほか ${rest} 件は${p.more}を参照`] : [])];
        return `${p.open}${items.join("、")}${p.close}`;
      })
      .join("");
  const length = () => [...render()].length;
  for (let added = true; added; ) {
    added = false;
    for (const s of lists) {
      if (s.full || s.shown === s.list.items.length) continue;
      s.shown += 1;
      if (length() <= WORK_LOG_MAX) added = true;
      else {
        s.shown -= 1;
        s.full = true;
      }
    }
  }
  for (const s of lists) {
    const next = s.list.items[s.shown];
    if (next === undefined) continue;
    const mark = `…（途中で切った。全文は${s.list.more}を参照）`;
    s.cut = mark;
    const room = WORK_LOG_MAX - length();
    s.cut = room >= WORK_LOG_MIN_CUT ? [...next].slice(0, room).join("") + mark : null;
  }
  const chars = [...render()];
  if (chars.length <= WORK_LOG_MAX) return chars.join("");
  const mark = `…（作業ログの上限 ${WORK_LOG_MAX} 字で切った）`;
  return chars.slice(0, WORK_LOG_MAX - [...mark].length).join("") + mark;
}

// 作業ログを1件書き、返った id を own-logs.md に記録する。書けなければ終了コードと nod のエラー文を返す
function writeWorkLog(work: string, issue: string, text: string, kind: "progress" | "blocker" | "test", what: string): { id: number | null; problem: string | null } {
  const p = nod(["--json", "issue", "log", issue, text, "--kind", kind]);
  const id = (parseJson(p) as { id?: unknown } | undefined)?.id;
  if (typeof id !== "number") return { id: null, problem: failure(p) };
  recordOwnLog(work, id, what);
  return { id, problem: null };
}

// 11節（13節の7）: 報告の保存と作業ログの後に merge-ready を付け外しし、本文が [ci-result] で始まる --kind test の作業ログに1件残して own-logs.md に記録する。
// 可なら付ける直前に現在の head と基点を取り直し、違う・取り直せない・保存に失敗したときは付けない（付いていれば外す）
// 一覧（不可の理由 blockers と加えた確認が残る事項 added）が上限に収まらなければ、書けなかった件数と全文の場所 more を書く
function applyMergeReady(
  work: string,
  prep: Prepared,
  issue: string,
  x: { merge: string; blockers: string[]; ci: CiRecord | null; head: HeadCheck | null; reportId: number | null; runId: string; saveProblem: string | null; extra: string[]; added: string[]; more: string },
): LabelResult {
  const labels = issueLabels(issue);
  const labeled = labels?.includes("merge-ready") ?? false;
  const blockers = [...x.blockers];
  let head = x.head;
  if (x.merge === MERGE_OK) {
    if (x.saveProblem) blockers.push(x.saveProblem);
    else {
      head = takeHead(work, prep, x.ci?.base ?? null, "merge-ready を付ける直前");
      blockers.push(...headProblems(head));
    }
  }
  let operation: LabelResult["operation"] = "付けていない";
  let error: string | null = labels === null ? "Issue のラベルを読めない" : null;
  if (blockers.length === 0) {
    const p = nod(["issue", "update", issue, "--add-label", "merge-ready"]);
    operation = p.code === 0 ? "付けた" : "付けられなかった";
    if (p.code !== 0) error = `ラベルを付けられない（${failure(p)}）`;
  } else if (labeled) {
    const p = nod(["issue", "update", issue, "--remove-label", "merge-ready"]);
    operation = p.code === 0 ? "外した" : "外せなかった";
    if (p.code !== 0) error = `ラベルを外せない（${failure(p)}）`;
  }
  const ci = x.ci;
  const text = fitWorkLog([
    `${CI_LOG} merge-ready: ${operation}`,
    logList("（マージ可否が不可: ", blockers, "）", x.more),
    "。",
    `判定した head SHA ${prep.head}${head?.currentHead ? `、現在の head ${head.currentHead}（${head.headOk ? "一致" : "不一致"}）` : head?.problem ? `、${head.problem}` : ""}、`,
    `基点 ${ci?.base ?? prep.base}（merge-base ${prep.mergeBase}）${head ? `、現在の基点 ${head.currentBase ?? "取り直せない"}（${head.baseOk ? "一致" : "不一致"}）` : ""}、`,
    `${ci ? ciSummary(ci) : "CI は照合せず"}、マージ可否 ${blockers.length === 0 ? MERGE_OK : NOT_RUN_MERGE}、`,
    `報告Document ${x.reportId ?? "保存できず"}、runId ${x.runId}${x.extra.map((e) => `、${e}`).join("")}`,
    logList(`、加えた確認が残る事項 ${x.added.length} 件（`, x.added, "）", x.more),
    "、",
    `CI の記録 ${ci ? `${join(work, dirname(ci.record))}/（${basename(ci.record)} の sha256 ${ci.sha256}）` : "なし"}。`,
    "ラベルは現在の判定の表示で、自動マージの指示ではない。",
    ...(error ? [`ラベルの操作の問題: ${error}。`] : []),
  ]);
  const log = writeWorkLog(work, issue, text, "test", "merge-ready の操作の記録（--kind test）");
  const logError = log.problem ? `[ci-result] の作業ログを書けない（${log.problem}）` : null;
  return { operation, blockers, head, error: [error, logError].filter((e) => e !== null).join("。") || null, log: log.id };
}

// 11節の作業ログ（完了は progress、未実施・未完了は blocker）の本文。CI 判定・マージ可否・merge-ready は書かず [ci-result] の記録を参照する。
// 末尾に保存までの確定値（報告には書き戻さない計測）を書く。上限に収まらない一覧は、書けなかった件数と結果・監査の場所を書く
function summaryLog(c: ReportContext, reportId: number | null, auditId: number | null, saveProblems: string[], final: FinalUsage): string {
  const agents = loadList<AgentRecord>(c.work, "agents");
  const retired = loadList<AttemptRecord>(c.work, "attempts");
  const ids = agents.map((a) => `${a.roleName}=${a.definition}/${a.agentId ?? "不明"}（試行 ${a.attempt}${retired.some((x) => x.role === a.role && x.attempt === a.attempt) ? "、無効" : ""}）`).join("、") || "なし";
  const more = `${reportId !== null ? `結果 Document ${reportId}` : `結果 ${join(c.work, "parent/report.md")}`}（監査 ${auditId ?? join(c.work, "parent/audit.md")}）`;
  const retries = logList(
    "無効な試行: ",
    retired.map((a) => `${a.roleName}の試行 ${a.attempt} ${a.agentId ?? "不明"}（${a.failureLabel}: ${a.reason}。委譲し直し${a.redelegate ? "する" : "しない"}）`),
    "。",
    more,
  );
  const docs = [`結果Document ${reportId ?? "保存できず"}、監査Document ${auditId ?? "保存できず"}`, logList("（保存・照合の問題: ", saveProblems, "）", `finalize の記録（${join(c.work, "parent/finalize.json")} の saveProblems）`)];
  const ciNote = "CI 判定・マージ可否・merge-ready は [ci-result] で始まる --kind test の作業ログを参照";
  if (c.state.status === "完了") {
    const required = c.state.refute?.required ?? [];
    const judged = c.state.acceptance?.judgments ?? [];
    return fitWorkLog([
      `独立コードレビュー完了。確定した要対応の点数 ${c.score}。`,
      logList("要対応: ", required.map((r) => `${r.heading}（${severityOf(r.impact)}: ${r.title}）`), "。", more, "要対応: なし。"),
      logList("受け入れ確認: ", judged.map((j) => `${j.source}=${j.verdict}`), "。", more),
      `確認が残る事項 ${c.remaining.length} 件`,
      logList("（", c.remaining.map((r) => `${r.ref}（${r.owner}、${r.reason}）`), "）", more),
      "。",
      ...docs,
      `。runId ${c.runId}。担当: ${ids}。`,
      retries,
      `${ciNote}。`,
      finalUsageText(final, c.work),
    ]);
  }
  return fitWorkLog([
    `独立コードレビュー${c.state.status}。原因: ${c.state.reason}。`,
    `試行: ${ids}。`,
    retries,
    `受領済みの成果: ${agents.filter((a) => a.receivedAt).map((a) => `${a.roleName}の試行 ${a.attempt}`).join("、") || "なし"}。点数なし。`,
    ...docs,
    `。runId ${c.runId}。Done・In Review・PR へ進めない。${ciNote}。`,
    finalUsageText(final, c.work),
  ]);
}

// ---- finalize（parent.md 10節・11節） ----

// parent/finalize.json の形（recheck-ci が読む部分）
interface FinalizeRecord {
  status: Status;
  reason: string | null;
  scoreValue: number | null;
  remaining: Remaining[];
  ci: CiRecord;
  acceptance: boolean;
  documents: { audit: SavedDocument; report: SavedDocument } | null;
}

function finalize(args: string[]): Outcome {
  const o = parseOptions(args, ["work", "not-run-reason", "session", "skill-start", "auto-check-rows"], ["own-log"]);
  const work = absolute("work", o.one.get("work"));
  if (!work) throw new UsageError("--work <W の絶対パス> が要ります");
  const prep = prepareRecord(work);
  if (existsSync(join(work, "parent/finalize.json"))) throw new UsageError("finalize は実行済みです（報告を保存し直さない。CI の照合し直しは recheck-ci）");
  if (existsSync(join(work, "parent/ci/1")) && readdirSync(join(work, "parent/ci/1")).length > 0) throw new UsageError("parent/ci/1/ が空ではありません（CI の照合は finalize が1回だけ行う）");
  // 評価用の事例では CI を除いたレビュー側の判定のために自動チェック担当の行の扱いが要る（通常のレビューでは使わない）
  const autoCheckRows = o.one.get("auto-check-rows");
  if (prep.caseDir && autoCheckRows !== "pass" && autoCheckRows !== "block") throw new UsageError("評価用の事例では --auto-check-rows pass|block（run.md で固定した自動チェック担当の行の扱い）が要ります");
  if (!prep.caseDir && autoCheckRows !== undefined) throw new UsageError("--auto-check-rows は評価用の事例（prepare --case）だけで使います");
  const session = parentSession(absolute("session", o.one.get("session")));
  const skillStartArg = o.one.get("skill-start");
  if (skillStartArg !== undefined && Number.isNaN(Date.parse(skillStartArg))) throw new UsageError(`--skill-start は ISO 8601 の時刻にしてください: ${skillStartArg}`);
  const ownLogs = recordOwnLogArgs(work, prep, o, "写しの後に親が Issue へ書いた記録");
  const runId = basename(work);
  const mode: ReportContext["mode"] = prep.caseDir ? "case" : prep.issue ? "issue" : "request";
  const state = reviewStatus(work, prep, o.one.get("not-run-reason"));
  const score = state.status === "完了" && state.refute ? Math.min(5, ...state.refute.required.flatMap((r) => (r.impact === null ? [] : [r.impact]))) : null;

  // 10節の1〜3: 保存直前の再照合（未コミット変更・要求・受け入れ確認が判定に使った証拠）
  const ready = prep.ready;
  const local = ready && prep.mode === "local" ? recheckLocal(work, prep, join(work, "parent/local-recheck")) : null;
  const requirements = ready ? recheckRequirements(work, prep, join(work, "parent/requirements-recheck")) : null;
  const evidence = state.acceptance ? recheckEvidence(work, prep, state.acceptance, join(work, "parent/acceptance-recheck")) : null;
  const remaining = [...verdictRemaining(state.refute, state.acceptance), ...recheckRemaining("保存直前の再照合", requirements, local, evidence)];

  // 10節の8: 同じ head の CI を1回だけ照合し、現在の head と基点を取り直す
  const base = ciBranch(prep);
  const rules = join(work, "parent/requirements-recheck/workspace-rules.md");
  const skip =
    state.status === "未実施"
      ? { verdict: "照合せず（未実施）", reason: "独立レビュー未実施のため照合しなかった" }
      : prep.caseDir
        ? { verdict: "照合せず（評価用の事例）", reason: "評価用の事例（prepare --case）では CI の照合を比較に使わないので省いた" }
        : prep.mode === "local"
          ? { verdict: "対象外（未コミット）", reason: "CI の結果は commit 済みの head に対するもので未コミット変更を含まない" }
          : !existsSync(rules)
            ? { verdict: "必須のチェックを決められず", reason: "Workspace の規約を取り直せない（parent/requirements-recheck/ の取得できなかった資料）" }
            : null;
  const ci = checkCi(work, prep, 1, base, rules, skip);
  const head = state.status !== "未実施" && prep.mode === "commit" && !prep.caseDir ? takeHead(work, prep, ci.base, "マージ可否を決める直前") : null;
  const mergeInput: MergeInput = { status: state.status, reason: state.reason, score, refute: state.refute, acceptance: state.acceptance, remaining: remaining.length, ci, head, prep };
  const decision = decideMerge(mergeInput);
  const reviewSide = autoCheckRows === "pass" || autoCheckRows === "block" ? reviewSideMerge(mergeInput, autoCheckRows) : null;
  const labeled = mode === "issue" && prep.issue ? (issueLabels(prep.issue)?.includes("merge-ready") ?? false) : false;
  const labelPlan =
    mode === "case" ? "扱わない（評価用の事例）" : mode === "request" ? "扱わない（Issue なし）" : decision.merge === MERGE_OK ? "付ける予定（付ける直前に現在の head と基点を取り直す）" : labeled ? "外す予定" : "付けない";

  // 報告の組み立て・保存の直前。報告に載せる区間の値（計測の1つ目）はこの時刻までを数える
  const reportStartedAt = now();
  const usage = reportUsage(work, prep, session, reportStartedAt);
  const ctx: ReportContext = { work, prep, runId, mode, state, score, remaining, ci, head, decision, labelPlan, requirements, local, evidence, usage, reviewSide };
  const audit = renderAudit(ctx);
  writeFileSync(join(work, "parent/audit.md"), audit);
  const markers = [
    { name: "refute-verdict", sha256: state.refute?.sha256 ?? null },
    { name: "acceptance-result", sha256: state.acceptance?.sha256 ?? null },
  ];
  const problems = markerProblems(audit, markers, "監査の原稿 parent/audit.md");
  let documents: FinalizeRecord["documents"] = null;
  let report: string;
  if (mode === "issue" && prep.issue) {
    const date = now().slice(0, 10).replaceAll("-", "");
    const short = runId.slice(0, 8);
    const lower = prep.issue.toLowerCase();
    const auditDoc = saveDocument(prep.issue, `${lower}-code-review-audit-${date}-${short}.md`, `${prep.issue} コードレビュー監査（${short}）`, audit, markers);
    report = renderReport(ctx, auditDoc.id !== null ? `監査 Document ${auditDoc.id}（${auditDoc.path}）` : `監査 Document の保存に失敗（原稿 ${join(work, "parent/audit.md")}）`);
    writeFileSync(join(work, "parent/report.md"), report);
    const reportDoc = saveDocument(prep.issue, `${lower}-code-review-${date}-${short}.md`, `${prep.issue} コードレビュー結果（${short}）`, report, []);
    documents = { audit: auditDoc, report: reportDoc };
    problems.push(...auditDoc.problems, ...reportDoc.problems);
  } else {
    report = renderReport(ctx, `監査記録 ${join(work, "parent/audit.md")}`);
    writeFileSync(join(work, "parent/report.md"), report);
  }
  const saved = problems.length === 0;
  // 保存と保存後の指紋照合の完了。保存後の作業ログと親専用領域の確定値（計測の2つ目）と MIN-33 の前後比較用の値（3つ目）はこの時刻までを数える
  const savedAt = now();
  const measured = finishUsage(work, session, usage, savedAt, skillStartArg);

  let summaryLogId: number | null = null;
  let label: LabelResult | null = null;
  let logProblem: string | null = null;
  if (mode === "issue" && prep.issue) {
    const kind = state.status === "完了" ? "progress" : "blocker";
    const log = writeWorkLog(work, prep.issue, summaryLog(ctx, documents?.report.id ?? null, documents?.audit.id ?? null, problems, measured.final), kind, `独立レビューの要約の作業ログ（--kind ${kind}）`);
    summaryLogId = log.id;
    if (log.problem) logProblem = `要約の作業ログを書けない（${log.problem}）`;
    label = applyMergeReady(work, prep, prep.issue, {
      merge: decision.merge,
      blockers: decision.blockers,
      ci,
      head,
      reportId: documents?.report.id ?? null,
      runId,
      saveProblem: saved ? null : `報告の保存・照合に失敗（${problems.join("、")}）`,
      extra: [],
      added: [],
      more: `finalize の記録（${join(work, "parent/finalize.json")} の blockers）`,
    });
  }
  // 保存・照合の失敗や付ける直前の head・基点の変化で付けなかったときは、マージ可否を不可として扱う（報告 Document は書き換えない）
  const blockers = label ? label.blockers : saved ? decision.blockers : [...decision.blockers, `報告の照合に失敗（${problems.join("、")}）`];
  const record: FinalizeRecord & Json = {
    runId,
    mode,
    status: state.status,
    reason: state.reason,
    score: score ?? NOT_RUN_SCORE,
    scoreValue: score,
    remainingCount: remaining.length,
    remaining,
    merge: blockers.length === 0 ? MERGE_OK : NOT_RUN_MERGE,
    reportedMerge: decision.merge,
    blockers,
    ci,
    head,
    acceptance: state.acceptance !== null,
    recheck: {
      requirements: requirements && { at: requirements.at, changed: requirements.changed, unavailable: requirements.unavailable },
      local: local && { at: local.at, changed: local.changed },
      evidence: evidence && { at: evidence.at, observations: evidence.observations.length, appended: evidence.appended.length, others: evidence.appended.filter((x) => !x.kept).length, own: evidence.appended.filter((x) => x.kept).length, events: evidence.events },
    },
    report: join(work, "parent/report.md"),
    audit: join(work, "parent/audit.md"),
    reportSha256: sha256(report),
    auditSha256: sha256(audit),
    documents,
    saved,
    saveProblems: problems,
    logs: { summary: summaryLogId, ci: label?.log ?? null, ownLogs },
    label: label ? { operation: label.operation, error: label.error } : { operation: labelPlan, error: null },
    logProblem,
    reportStartedAt,
    savedAt,
    reviewSideMerge: reviewSide,
    usage: {
      record: join(work, "parent/usage.json"),
      report: { from: usage.from, to: usage.to, seconds: usage.seconds, parentTotalTokens: usage.parent.tally?.totalTokens ?? null },
      final: { from: measured.final.from, to: measured.final.to, seconds: measured.final.seconds, parentTotalTokens: measured.final.parent.tally?.totalTokens ?? null },
      comparison: { from: measured.comparison.from, to: measured.comparison.to, seconds: measured.comparison.seconds, parentTotalTokens: measured.comparison.parent.tally?.totalTokens ?? null },
    },
  };
  return { work, result: record };
}

// ---- recheck-ci（parent.md 13節。レビューをやり直さず、同じ head の CI とマージ可否を照合し直す） ----

function recheckCi(args: string[]): Outcome {
  const o = parseOptions(args, ["work"], ["own-log"]);
  const work = absolute("work", o.one.get("work"));
  if (!work) throw new UsageError("--work <W の絶対パス> が要ります");
  const prep = prepareRecord(work);
  const fin = readRecord<FinalizeRecord & { runId?: string; scoreValue?: number | null }>(join(work, "parent/finalize.json"));
  if (!fin) throw new UsageError("finalize の記録（parent/finalize.json）がありません。保存したレビューの作業ディレクトリ（監査の管理情報の作業ディレクトリ）を指定してください");
  if (prep.caseDir) throw new UsageError("評価用の事例では CI を照合しません");
  const ownLogs = recordOwnLogArgs(work, prep, o, "保存の後・CI の再照合の前に親・PM が Issue へ書いた記録");
  const parent = join(work, "parent");
  const numbers = [...(existsSync(join(parent, "ci")) ? readdirSync(join(parent, "ci")) : []), ...readdirSync(parent).filter((n) => n.startsWith("recheck-")).map((n) => n.slice("recheck-".length))]
    .map(Number)
    .filter(Number.isInteger);
  const n = Math.max(0, ...numbers) + 1;
  const dir = join(parent, `recheck-${n}`);
  mkdirSync(dir, { recursive: true });
  const runId = basename(work);
  const reportId = fin.documents?.report.id ?? null;
  const auditId = fin.documents?.audit.id ?? null;
  const reportBase = fin.ci.base ?? ciBranch(prep);
  const at = now();

  // 1・2: 現在の head（PR なら基点も）を取り直し、違えば照合しない
  const head = prep.mode === "commit" ? takeHead(work, prep, reportBase, `CI の再照合 ${n}`) : null;
  let reason: string | null = null;
  let blockers: string[] = [];
  let ci: CiRecord | null = null;
  let added: Remaining[] = [];
  let requirements: RequirementsRecheck | null = null;
  let evidence: EvidenceRecheck | null = null;
  if (head && (head.problem || !head.headOk)) {
    reason = head.problem ?? `判定が古い（追加コミット。報告の head ${prep.head}、現在の head ${head.currentHead}）`;
    blockers = [reason];
  } else {
    // 3: 照合し直しても可にならない条件と、使う記録の有無
    const records = [
      "input/target.md",
      "input/requirements",
      "input/manifest.md",
      ...(prep.issue ? [OWN_LOGS] : []),
      ...(fin.acceptance ? ["acceptance-input/records.md", "acceptance/result.md", "parent/acceptance-structure.json", "parent/acceptance/items.json", "parent/acceptance/evidence.json", ...(prep.issue ? ["parent/acceptance/activity.json"] : [])] : []),
    ];
    const missing = records.filter((r) => !existsSync(join(work, r)));
    const audit = auditId !== null ? docContent(auditId) : null;
    const cond = [
      ...(fin.status === "完了" ? [] : [`報告の最終状態が完了でない（${fin.status}）`]),
      ...(fin.scoreValue === 5 ? [] : [`確定した要対応の点数が 5 でない（${fin.scoreValue ?? NOT_RUN_SCORE}）`]),
      ...(fin.remaining.length > 0 ? [`報告の確認が残る事項 ${fin.remaining.length} 件`] : []),
      ...(prep.mode === "local" ? ["mode: local"] : []),
      ...(missing.length > 0 ? [`作業ディレクトリの記録が無い: ${missing.map((m) => join(work, m)).join("・")}`] : []),
      ...(typeof audit === "string" ? [`監査 Document ${auditId} を読めない（${audit}）`] : audit && !(audit.content.includes(`- runId: ${runId}`) && audit.content.includes(prep.head)) ? [`監査 Document ${auditId} の runId・対象 SHA が作業ディレクトリと一致しない`] : []),
    ];
    if (cond.length > 0) {
      reason = `照合し直しても可にならない: ${cond.join("・")}`;
      blockers = cond;
    } else {
      // 4: 10節の2・3を recheck-<n>/ へやり直す
      requirements = recheckRequirements(work, prep, join(dir, "requirements"));
      const accepted = fin.acceptance ? readRecord<AcceptanceStructure>(join(work, "parent/acceptance-structure.json")) : null;
      evidence = accepted ? recheckEvidence(work, prep, accepted, join(dir, "acceptance")) : null;
      added = recheckRemaining(`CI の再照合 ${n}`, requirements, null, evidence);
      // 5: CI を parent/ci/<n>/ へ1回だけ照合する
      const rules = join(dir, "requirements/workspace-rules.md");
      ci = checkCi(work, prep, n, reportBase, rules, existsSync(rules) ? null : { verdict: "必須のチェックを決められず", reason: "Workspace の規約を取り直せない" });
      // 6: 報告の判定に4で加えた事項を合わせ、10節の8と同じ規則で決める
      const refute = readRecord<RefuteStructure>(join(work, "parent/refute-structure.json"));
      const decision = decideMerge({ status: fin.status, reason: fin.reason, score: fin.scoreValue ?? null, refute, acceptance: accepted, remaining: fin.remaining.length + added.length, ci, head, prep });
      blockers = decision.blockers.map((b) => (b.startsWith("基点が変わった") ? `${b}（PR の基点が報告の基点と違うので、CI 判定は必須のチェックを決められずとして扱う）` : b));
    }
  }
  const merge = blockers.length === 0 ? MERGE_OK : NOT_RUN_MERGE;
  // 7: merge-ready の付け外しと [ci-result] の記録
  const label = prep.issue
    ? applyMergeReady(work, prep, prep.issue, {
        merge,
        blockers,
        ci,
        head,
        reportId,
        runId,
        saveProblem: null,
        extra: [`CI の再照合 ${n}`, ...(reason ? [`照合せず: ${reason}`] : [])],
        added: added.map((a) => `${a.ref}（${a.reason}）`),
        more: `CI の再照合の記録（${join(dir, "record.md")}）`,
      })
    : null;
  const finalMerge = label ? (label.operation === "付けた" ? MERGE_OK : NOT_RUN_MERGE) : merge;
  // 8: 再照合の記録
  const md = [
    `# CI の再照合 ${n}`,
    "",
    `- 報告の Document ID: 結果 ${reportId ?? "なし（Issue なし）"}、監査 ${auditId ?? "なし"}`,
    `- runId: ${runId}`,
    `- 照合した時刻: ${at}`,
    `- 比べた head: 報告の head \`${prep.head}\`、現在の head ${head?.currentHead ? `\`${head.currentHead}\`` : "取り直せない"}、現在の基点 ${head?.currentBase ?? "取り直せない"}（\`${head?.command ?? "なし"}\`、${head?.at ?? at}）`,
    `- 照合せずに終えた理由: ${reason ?? "なし（照合した）"}`,
    `- 要求の再照合: ${requirements ? `${requirements.compared.join("・")} を比べた。${requirements.changed.length > 0 ? `変化あり: ${requirements.changed.map((c) => c.path).join("・")}` : "変化なし"}（${join(dir, "requirements")}）` : "照合せず"}`,
    `- 受け入れ証拠の再照合: ${evidence ? `${evidence.compared.length} 件を比べ、観測 ${evidence.observations.length} 件、固定の後に足された Activity ${evidence.appended.length} 件（親以外の追記 ${evidence.appended.filter((x) => !x.kept).length} 件、親自身の記録 ${evidence.appended.filter((x) => x.kept).length} 件）、イベント ${evidence.events} 件（${join(dir, "acceptance")}）` : fin.acceptance && !reason ? "照合せず" : reason ? "照合せず" : "対象なし（受け入れ確認担当を起動していない）"}`,
    `- 加えた確認が残る事項: ${added.length > 0 ? added.map((a) => `${a.ref}（${a.owner}、${a.reason}）`).join("・") : "なし"}`,
    `- CI の記録: ${ci ? `${join(work, ci.record)}（sha256 ${ci.sha256}）、${ciSummary(ci)}` : "照合せず"}`,
    `- マージ可否: ${finalMerge}${label?.blockers.length || blockers.length ? `（理由: ${(label?.blockers ?? blockers).join("／")}）` : ""}`,
    `- ラベルの操作: ${label ? `${label.operation}${label.error ? `（${label.error}）` : ""}` : "扱わない（Issue なし）"}`,
    `- この再照合で書いた作業ログの id: ${label?.log ?? "なし"}（${OWN_LOGS} に記録）`,
    "",
  ].join("\n");
  writeFileSync(join(dir, "record.md"), md);
  return {
    work,
    result: { n, runId, checked: ci !== null, reason, merge: finalMerge, blockers: label?.blockers ?? blockers, ci, head, added, label: label ? { operation: label.operation, error: label.error, log: label.log } : null, ownLogs, record: join(dir, "record.md") },
  };
}

// ---- 区間の時間と使用量（parent.md 14節。段階・委譲の時刻と omp のセッション記録から集計する） ----

// 段階（サブコマンド）の記録。振り分け（main）が終了コード 0 で終えた呼び出しごとに parent/stages.json（と stages.md）へ足す
export interface StageRecord {
  subcommand: string;
  startedAt: string;
  endedAt: string | null;
  args: string[];
}

// 今の呼び出し（main が設定する）。finalize は自分の段階の終わりより前に計測するので、実行中の段階として載せる
let currentStage: StageRecord | null = null;

const secondsBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;
const duration = (s: number | null) => (s === null ? "取得できず" : `${(s / 60).toFixed(1)}分（${s.toFixed(1)}秒）`);
const tokens = (n: number | null) => (n === null ? "取得できず" : String(n));

function renderStages(list: StageRecord[]): string {
  return [
    "# 段階の記録",
    "",
    "review.ts の各サブコマンドを終了コード 0 で終えた呼び出しの開始と終了の時刻（ISO 8601、UTC）。委譲の開始と最終返答の受領は agents.md。",
    "",
    "| サブコマンド | 引数 | 開始 | 終了 | 時間 |",
    "|---|---|---|---|---|",
    ...list.map((s) => `| ${s.subcommand} | ${cell(s.args.join(" ")) || "なし"} | ${s.startedAt} | ${s.endedAt ?? "実行中"} | ${s.endedAt ? duration(secondsBetween(s.startedAt, s.endedAt)) : "実行中"} |`),
    "",
  ].join("\n");
}

function recordStage(work: string, stage: StageRecord): void {
  if (!existsSync(join(work, "parent"))) return;
  const list = [...loadList<StageRecord>(work, "stages"), stage];
  saveList(work, "stages", list, renderStages(list));
}

// omp のセッション記録の1行（外側の timestamp を持つものだけ）
interface SessionRecord {
  at: number;
  iso: string;
  type: string;
  role: string | null;
  usage: Record<string, unknown> | null;
  stop: string | null;
  error: string | null;
  // ツール呼び出しの引数に出る文字列（スキルの読み込みの応答を見分ける）
  tools: string[];
}

// 計測の出典（記録ファイルのパスと sha256。取得できなければ unavailable に理由）
export interface Source {
  path: string | null;
  sha256: string | null;
  unavailable: string | null;
  readAt?: string;
  records?: number;
  // 時刻の無い行（title など）と読めない行の数
  untimed?: number;
  sessionAt?: string | null;
  parentSession?: string | null;
}

interface SessionFile {
  source: Source;
  records: SessionRecord[] | null;
}

const isResponse = (r: SessionRecord) => r.type === "message" && r.role === "assistant";

function stringsIn(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(stringsIn);
  return v !== null && typeof v === "object" ? Object.values(v).flatMap(stringsIn) : [];
}

function readSession(path: string | null, missing: string): SessionFile {
  if (!path) return { source: { path: null, sha256: null, unavailable: missing }, records: null };
  if (!existsSync(path)) return { source: { path, sha256: null, unavailable: `記録が無い（${path}）` }, records: null };
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (e) {
    return { source: { path, sha256: null, unavailable: `記録を読めない（${path}: ${e instanceof Error ? e.message : String(e)}）` }, records: null };
  }
  const records: SessionRecord[] = [];
  let untimed = 0;
  let sessionAt: string | null = null;
  let parentSession: string | null = null;
  for (const line of data.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    let j: Json;
    try {
      j = JSON.parse(line) as Json;
    } catch {
      untimed++;
      continue;
    }
    const iso = typeof j.timestamp === "string" ? j.timestamp : "";
    const at = Date.parse(iso);
    if (Number.isNaN(at)) {
      untimed++;
      continue;
    }
    const m = j.message !== null && typeof j.message === "object" ? (j.message as Json) : null;
    if (j.type === "session" && sessionAt === null) {
      sessionAt = iso;
      parentSession = typeof j.parentSession === "string" ? j.parentSession : null;
    }
    records.push({
      at,
      iso,
      type: String(j.type),
      role: typeof m?.role === "string" ? m.role : null,
      usage: m?.usage !== null && typeof m?.usage === "object" ? (m.usage as Record<string, unknown>) : null,
      stop: typeof m?.stopReason === "string" ? m.stopReason : null,
      error: typeof m?.errorMessage === "string" ? m.errorMessage : null,
      tools: Array.isArray(m?.content) ? (m.content as Json[]).filter((c) => c?.type === "toolCall").flatMap((c) => stringsIn(c.arguments)) : [],
    });
  }
  return { source: { path, sha256: sha256(data), unavailable: null, readAt: now(), records: records.length, untimed, sessionAt, parentSession }, records };
}

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
type UsageField = (typeof USAGE_FIELDS)[number];

// 範囲の assistant の応答の使用量（欄の無い応答があればその欄は null = 取得できず）
export interface Tally {
  responses: number;
  turns: number;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  totalTokens: number | null;
  maxContext: number | null;
  missing: UsageField[];
  // omp 内部の retry（エラーで止まった応答と credential_pin の記録）。親による再委譲とは別
  retries: { errors: { at: string; message: string }[]; credentialPins: string[] };
  first: string | null;
  last: string | null;
  // 担当の記録だけ: 委譲の開始から最終返答の受領までの外にある応答の数（使用量には入れない）
  outside?: number;
}

function tally(records: SessionRecord[], from: number, to: number): Tally {
  const inside = (r: SessionRecord) => r.at >= from && r.at < to;
  const res = records.filter((r) => isResponse(r) && inside(r));
  const num = (r: SessionRecord, f: UsageField) => (typeof r.usage?.[f] === "number" ? (r.usage[f] as number) : null);
  const missing = USAGE_FIELDS.filter((f) => res.some((r) => num(r, f) === null));
  const sum = (f: UsageField) => (missing.includes(f) ? null : res.reduce((a, r) => a + (num(r, f) ?? 0), 0));
  const answered = res.filter((r) => r.stop !== "error");
  const contexts = answered.map((r) => [num(r, "input"), num(r, "cacheRead"), num(r, "cacheWrite")]);
  const known = contexts.every((c) => c.every((x) => x !== null));
  return {
    responses: res.length,
    turns: answered.length,
    input: sum("input"),
    output: sum("output"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    totalTokens: sum("totalTokens"),
    maxContext: answered.length > 0 && known ? Math.max(...contexts.map((c) => (c[0] ?? 0) + (c[1] ?? 0) + (c[2] ?? 0))) : null,
    missing,
    retries: {
      errors: res.filter((r) => r.stop === "error").map((r) => ({ at: r.iso, message: r.error ?? "（エラーの文言なし）" })),
      credentialPins: records.filter((r) => r.type === "credential_pin" && inside(r)).map((r) => r.iso),
    },
    first: res[0]?.iso ?? null,
    last: res.at(-1)?.iso ?? null,
  };
}

// 範囲の使用量と出典。記録が無い・読めなければ tally は null（0 にしない）
export interface Measured {
  source: Source;
  tally: Tally | null;
  unavailable: string | null;
}

function measure(file: SessionFile, from: number, to: number): Measured {
  return file.records ? { source: file.source, tally: tally(file.records, from, to), unavailable: null } : { source: file.source, tally: null, unavailable: file.source.unavailable };
}

const totalOf = (list: Measured[]) => (list.every((m) => typeof m.tally?.totalTokens === "number") ? list.reduce((a, m) => a + (m.tally?.totalTokens ?? 0), 0) : null);

const USAGE_DEFINITIONS = {
  range: "時刻の範囲は開始を含み終了を含まない（ISO 8601、UTC）",
  usage:
    "使用量は omp のセッション記録の assistant の応答のうち、外側の記録の timestamp（応答の中の時刻ではない）が範囲に入るものの usage を応答単位で合計した。境界をまたぐ応答を時間で分割しない。各応答にはその時点までの文脈（キャッシュ読みを含む）が含まれる",
  turns: "ターンは stopReason が error でない応答の数（応答の数はエラーで止まった応答を含む）",
  maxContext: "最大文脈は、stopReason が error でない1応答の input + cacheRead + cacheWrite の最大",
  retries: "omp 内部の retry は、セッションの中でエラー（stopReason が error）で止まった応答と credential_pin の記録で、親による再委譲（試行の番号。担当 ID ごとに別の記録）とは分ける",
  agents:
    "担当の時間と使用量は、委譲の開始（agent --event start）から親が最終返答を受け取った時刻（agent --event received）までで、その後のセッションの片付けを含めない。その外の応答は件数（範囲外の応答）だけ書く。担当の記録は、親の記録と同名のディレクトリの <担当 ID>.jsonl",
  sections:
    "区間は委譲の時刻で分ける。担当の区間は段階（探索・反証・受け入れ確認）ごとの最初の委譲の開始から最後の最終返答の受領まで（並列の探索は2担当の時間を合算しない）、その前後と間を親の区間とする",
  missing: "取得できない値は 0 にせず「取得できず」（JSON では null）と理由を書く",
  report: "報告に載せる値: 最初の段階（prepare）の開始から、finalize が報告を組み立て始める直前（reportStartedAt）まで",
  final: "保存後の確定値: prepare の開始から、報告 Document の保存と保存後の指紋照合が終わった時刻（savedAt）まで（利用者への最終説明は含めない）。保存後の作業ログと親専用領域だけに書き、報告には書き戻さない",
  comparison: "MIN-33 の前後比較用: 親がスキルを読み込み始めた時刻（prepare の開始より前で最後に code-review の SKILL.md を読み込んだ応答の記録の時刻、または finalize の --skill-start）から savedAt まで",
};

// 親のセッション記録の場所（既定のパスを決め打ちしない）
interface ParentSession {
  path: string | null;
  origin: string;
  missing: string;
}

function parentSession(arg: string | undefined): ParentSession {
  if (arg) return { path: arg, origin: "finalize の --session", missing: "" };
  const env = process.env.PI_SESSION_FILE;
  if (env && isAbsolute(env)) return { path: env, origin: "環境変数 PI_SESSION_FILE（omp が bash から起動したプロセスに渡す親のセッション記録）", missing: "" };
  return { path: null, origin: "なし", missing: "親のセッション記録の場所が --session にも PI_SESSION_FILE にも無い" };
}

// 担当の記録: 親の記録と同名のディレクトリの <担当 ID>.jsonl
function agentSessionPath(parent: string | null, agentId: string | null): { path: string | null; missing: string } {
  if (!parent) return { path: null, missing: "親のセッション記録の場所が分からないので、担当の記録を引けない" };
  if (!agentId) return { path: null, missing: "担当 ID が記録されていない（agent --agent-id）" };
  return { path: join(dirname(parent), basename(parent, ".jsonl"), `${agentId}.jsonl`), missing: "" };
}

export interface AttemptUsage extends Measured {
  role: Role;
  roleName: string;
  attempt: number;
  agentId: string | null;
  startedAt: string;
  receivedAt: string | null;
  seconds: number | null;
  // 無効として隔離した試行の失敗の種類（有効・未検査は null）
  failure: string | null;
}

export interface SectionUsage {
  name: string;
  owner: string;
  from: string;
  to: string;
  seconds: number;
  // 最終返答を受け取っていない試行があり、終わりを報告の直前にした
  open: boolean;
  parent: Measured;
  agentsTotal: number | null;
  // 担当の区間に入る試行（<役割>#<試行の番号>）
  attempts: string[];
}

interface ReportUsage {
  from: string;
  to: string;
  seconds: number;
  session: ParentSession;
  stages: StageRecord[];
  sections: SectionUsage[];
  parent: Measured;
  attempts: AttemptUsage[];
}

const AGENT_SECTIONS: { stage: Stage; name: string; owner: string }[] = [
  { stage: "explore", name: "探索（並列）", owner: "Standards 探索・Spec 探索" },
  { stage: "refute", name: "反証", owner: "反証担当" },
  { stage: "acceptance", name: "受け入れ確認", owner: "受け入れ確認担当" },
];
// 親の区間の名前（前の担当の段階-次の担当の段階）
const PARENT_SECTIONS: Record<string, string> = {
  "-explore": "準備",
  "explore-refute": "引き渡しの検査",
  "refute-acceptance": "反証の検査と証拠集め",
  "-": "準備と仕上げ",
  "explore-": "引き渡しの検査と仕上げ",
  "refute-": "反証の検査と仕上げ",
  "acceptance-": "受け入れ確認の検査と仕上げ",
};

// 報告に載せる値: prepare の開始から cut（報告の組み立ての直前）までの区間ごとの時間と、親・各試行の使用量
function reportUsage(work: string, prep: Prepared, session: ParentSession, cut: string): ReportUsage {
  const stages = [...loadList<StageRecord>(work, "stages"), ...(currentStage ? [currentStage] : [])];
  const from = stages.find((s) => s.subcommand === "prepare")?.startedAt ?? prep.startedAt ?? cut;
  const file = readSession(session.path, session.missing);
  const retired = loadList<AttemptRecord>(work, "attempts");
  const attempts: AttemptUsage[] = loadList<AgentRecord>(work, "agents")
    .filter((a) => a.startedAt < cut)
    .map((a) => {
      const where = agentSessionPath(session.path, a.agentId);
      const agentFile = readSession(where.path, where.missing);
      const [start, end] = [Date.parse(a.startedAt), Date.parse(a.receivedAt ?? cut)];
      const m = measure(agentFile, start, end);
      if (m.tally && agentFile.records) m.tally.outside = agentFile.records.filter((r) => isResponse(r) && (r.at < start || r.at >= end)).length;
      const failure = retired.find((x) => x.role === a.role && x.attempt === a.attempt)?.failureLabel ?? null;
      return { role: a.role, roleName: a.roleName, attempt: a.attempt, agentId: a.agentId, startedAt: a.startedAt, receivedAt: a.receivedAt, seconds: a.receivedAt ? secondsBetween(a.startedAt, a.receivedAt) : null, failure, ...m };
    });
  const parentPart = (name: string, a: string, b: string): SectionUsage => ({ name, owner: "親", from: a, to: b, seconds: secondsBetween(a, b), open: false, parent: measure(file, Date.parse(a), Date.parse(b)), agentsTotal: null, attempts: [] });
  const sections: SectionUsage[] = [];
  let prev = from;
  let prevStage = "";
  for (const g of AGENT_SECTIONS) {
    const list = attempts.filter((a) => ROLES[a.role].stage === g.stage);
    if (list.length === 0) continue;
    const start = list.map((a) => a.startedAt).sort()[0] ?? prev;
    const open = list.some((a) => a.receivedAt === null);
    const end = open ? cut : (list.map((a) => a.receivedAt ?? cut).sort().at(-1) ?? cut);
    sections.push(parentPart(PARENT_SECTIONS[`${prevStage}-${g.stage}`] ?? "親", prev, start));
    sections.push({ name: g.name, owner: g.owner, from: start, to: end, seconds: secondsBetween(start, end), open, parent: measure(file, Date.parse(start), Date.parse(end)), agentsTotal: totalOf(list), attempts: list.map((a) => `${a.role}#${a.attempt}`) });
    prev = end;
    prevStage = g.stage;
  }
  sections.push(parentPart(PARENT_SECTIONS[`${prevStage}-`] ?? "仕上げ", prev, cut));
  return { from, to: cut, seconds: secondsBetween(from, cut), session, stages, sections, parent: measure(file, Date.parse(from), Date.parse(cut)), attempts };
}

export interface FinalUsage {
  from: string;
  to: string;
  seconds: number;
  parent: Measured;
}

export interface ComparisonUsage {
  from: string | null;
  to: string;
  seconds: number | null;
  // 始まりの決め方（取得できなければ理由）
  start: string;
  parent: Measured;
  attempts: AttemptUsage[];
  agentsTotal: number | null;
}

// スキルの読み込み（skill://code-review、または code-review/SKILL.md のパスを引数に持つツール呼び出し）
const SKILL_LOAD = /^skill:\/\/(?:[^/\s]*:)?code-review\/?$|(?:^|\/)code-review\/SKILL\.md$/;

// 保存後の確定値と MIN-33 の前後比較用の値を求め、3つの値を parent/usage.json と usage.md に書く
function finishUsage(work: string, session: ParentSession, report: ReportUsage, savedAt: string, skillStartArg: string | undefined): { final: FinalUsage; comparison: ComparisonUsage } {
  const file = readSession(session.path, session.missing);
  const final: FinalUsage = { from: report.from, to: savedAt, seconds: secondsBetween(report.from, savedAt), parent: measure(file, Date.parse(report.from), Date.parse(savedAt)) };
  const before = Date.parse(report.from);
  const hit = (file.records ?? [])
    .filter((r) => isResponse(r) && r.at < before && r.tools.some((t) => SKILL_LOAD.test(t)))
    .sort((a, b) => a.at - b.at)
    .at(-1);
  const start = skillStartArg
    ? { at: skillStartArg, how: "finalize の --skill-start で指定した時刻" }
    : !file.records
      ? { at: null, how: `取得できず（${file.source.unavailable}）` }
      : hit
        ? { at: hit.iso, how: `prepare の開始より前で最後に code-review の SKILL.md を読み込んだ応答（${hit.tools.find((t) => SKILL_LOAD.test(t))}）の記録の時刻` }
        : { at: null, how: "取得できず（prepare の開始より前に code-review の SKILL.md を読み込んだ応答が親の記録に無い。finalize の --skill-start で指定できる）" };
  const comparison: ComparisonUsage = {
    from: start.at,
    to: savedAt,
    seconds: start.at ? secondsBetween(start.at, savedAt) : null,
    start: start.how,
    parent: start.at ? measure(file, Date.parse(start.at), Date.parse(savedAt)) : { source: file.source, tally: null, unavailable: start.how },
    attempts: report.attempts,
    agentsTotal: totalOf(report.attempts),
  };
  const reportValue = { from: report.from, to: report.to, seconds: report.seconds, sections: report.sections, parent: report.parent, attempts: report.attempts };
  writeFileSync(join(work, "parent/usage.json"), `${JSON.stringify({ definitions: USAGE_DEFINITIONS, session, stages: report.stages, report: reportValue, final, comparison }, null, 2)}\n`);
  writeFileSync(join(work, "parent/usage.md"), renderUsage(work, report, final, comparison));
  return { final, comparison };
}

function usageText(m: Measured): string {
  const t = m.tally;
  if (!t) return `取得できず（${m.unavailable}）`;
  if (t.responses === 0) return "応答なし（0 件）";
  const missing = t.missing.length > 0 ? `。usage に ${t.missing.join("・")} の無い応答があり、その欄は取得できず` : "";
  return `合計 ${tokens(t.totalTokens)}（入力 ${tokens(t.input)}・出力 ${tokens(t.output)}・キャッシュ読み ${tokens(t.cacheRead)}・キャッシュ書き ${tokens(t.cacheWrite)}、応答 ${t.responses}・ターン ${t.turns}、最大文脈 ${tokens(t.maxContext)}${missing}）`;
}

function retryText(t: Tally | null): string {
  if (!t) return "取得できず";
  const errors = t.retries.errors;
  return `エラーで止まった応答 ${errors.length} 件${errors.length > 0 ? `（${errors.map((e) => `${e.at} ${e.message}`).join("・")}）` : ""}、credential_pin ${t.retries.credentialPins.length} 件`;
}

const sourceText = (s: Source) => (s.path === null ? `なし（${s.unavailable}）` : `\`${s.path}\`（${s.sha256 ? `sha256 ${s.sha256}、読んだ時刻 ${s.readAt}` : s.unavailable}）`);

function usageBody(u: ReportUsage, work: string): string[] {
  return [
    `- 範囲: ${u.from}（prepare の開始）から ${u.to}（報告の組み立ての直前）まで、${duration(u.seconds)}。${USAGE_DEFINITIONS.range}`,
    `- 定義: ${USAGE_DEFINITIONS.sections}。${USAGE_DEFINITIONS.usage}。${USAGE_DEFINITIONS.maxContext}。${USAGE_DEFINITIONS.turns}。${USAGE_DEFINITIONS.agents}。${USAGE_DEFINITIONS.retries}。${USAGE_DEFINITIONS.missing}`,
    `- 出典: 親 ${sourceText(u.parent.source)}（場所の決め方: ${u.session.origin}）。段階と委譲の時刻は \`${join(work, "parent/stages.md")}\`・\`${join(work, "parent/agents.md")}\`。担当は下の表`,
    `- 親の使用量（範囲全体）: ${usageText(u.parent)}。omp 内部の retry: ${retryText(u.parent.tally)}`,
    `- 保存までの確定値と MIN-33 の前後比較用の値は、保存の後に作業ログと \`${join(work, "parent/usage.md")}\` に書く（報告と監査には書き戻さない）`,
    "",
    "| 区間 | 担い手 | 開始 | 終了 | 時間 | 担当の使用量（合計） | 親の使用量 |",
    "|---|---|---|---|---|---|---|",
    ...u.sections.map((s) => `| ${s.name} | ${s.owner} | ${s.from} | ${s.to}${s.open ? "（最終返答の受領なし。報告の直前まで）" : ""} | ${duration(s.seconds)} | ${s.owner === "親" ? "対象外" : tokens(s.agentsTotal)} | ${cell(usageText(s.parent))} |`),
    "",
    ...(u.attempts.length > 0
      ? [
          "| 役割 | 試行 | 担当 ID | 委譲の開始 | 最終返答の受領 | 時間 | 無効 | 使用量 | omp 内部の retry | 範囲外の応答 | 出典 |",
          "|---|---|---|---|---|---|---|---|---|---|---|",
          ...u.attempts.map(
            (a) =>
              `| ${a.roleName} | ${a.attempt}${a.attempt > 1 ? "（再委譲）" : ""} | ${cell(a.agentId ?? "不明")} | ${a.startedAt} | ${a.receivedAt ?? "未受領"} | ${a.seconds === null ? "未受領" : duration(a.seconds)} | ${a.failure ?? "なし"} | ${cell(usageText(a))} | ${cell(retryText(a.tally))} | ${a.tally?.outside ?? "取得できず"} | ${cell(sourceText(a.source))} |`,
          ),
        ]
      : ["担当の委譲なし"]),
  ];
}

// 監査の計測の節（報告の組み立ての直前までの値と、その定義・出典・試行ごとの内訳）
function renderAuditUsage(u: ReportUsage, work: string): string[] {
  return ["### 計測（報告の組み立ての直前まで）", "", ...usageBody(u, work)];
}

// 結果の計測の節（短く。区間ごとの時間と合計だけ）
function renderReportUsage(u: ReportUsage): string[] {
  const short = (m: Measured) => (m.tally ? tokens(m.tally.totalTokens) : "取得できず");
  return [
    "## 計測（報告の組み立ての直前まで）",
    "",
    `- 範囲: ${u.from}（prepare の開始）から ${u.to}（報告の組み立ての直前）まで、${duration(u.seconds)}。担当の区間は最初の委譲の開始から最後の最終返答の受領まで（並列の探索は合算しない）。使用量は外側の記録の時刻が範囲に入る応答の合計トークン`,
    "- 保存までの確定値は保存後の作業ログと作業ディレクトリの parent/usage.md、試行ごとの内訳・最大文脈・出典は監査記録",
    "",
    "| 区間 | 担い手 | 時間 | 担当の使用量 | 親の使用量 |",
    "|---|---|---|---|---|",
    ...u.sections.map((s) => `| ${s.name} | ${s.owner} | ${duration(s.seconds)}${s.open ? "（受領なし）" : ""} | ${s.owner === "親" ? "対象外" : tokens(s.agentsTotal)} | ${short(s.parent)} |`),
  ];
}

// 保存後の作業ログに書く確定値
function finalUsageText(f: FinalUsage, work: string): string {
  return `計測（保存までの確定値。prepare の開始 ${f.from} から報告の保存と照合の完了 ${f.to} まで、開始を含み終了を含まない。利用者への説明は含まない）: ${duration(f.seconds)}、親の使用量 ${usageText(f.parent)}。区間別の値は結果 Document、MIN-33 の前後比較用の値と出典は ${join(work, "parent/usage.md")}。`;
}

function renderUsage(work: string, report: ReportUsage, final: FinalUsage, comparison: ComparisonUsage): string {
  return [
    "# 計測（区間別の時間と使用量）",
    "",
    "次の3つは範囲が違う別の値で、同じ「全体」として比べない。",
    "",
    `- ${USAGE_DEFINITIONS.report}`,
    `- ${USAGE_DEFINITIONS.final}`,
    `- ${USAGE_DEFINITIONS.comparison}`,
    "",
    "## 1. 報告に載せる値（報告の組み立ての直前まで）",
    "",
    ...usageBody(report, work),
    "",
    "## 2. 保存後の確定値（報告の保存と照合の完了まで）",
    "",
    `- 範囲: ${final.from}（prepare の開始）から ${final.to}（保存と保存後の指紋照合の完了）まで、${duration(final.seconds)}。${USAGE_DEFINITIONS.range}`,
    `- 親の使用量: ${usageText(final.parent)}。omp 内部の retry: ${retryText(final.parent.tally)}`,
    `- 出典: ${sourceText(final.parent.source)}`,
    "",
    "## 3. MIN-33 の前後比較用（スキルの読み込みから報告の保存まで）",
    "",
    `- 範囲: ${comparison.from ?? "取得できず"} から ${comparison.to}（保存と保存後の指紋照合の完了）まで、${duration(comparison.seconds)}。${USAGE_DEFINITIONS.range}`,
    `- 始まりの決め方: ${comparison.start}`,
    `- 親の使用量: ${usageText(comparison.parent)}。omp 内部の retry: ${retryText(comparison.parent.tally)}`,
    `- 担当の使用量の合計（全試行。各試行は 1 の表）: ${tokens(comparison.agentsTotal)}`,
    `- 出典: ${sourceText(comparison.parent.source)}`,
    "",
    "## 段階",
    "",
    "| サブコマンド | 開始 | 終了 |",
    "|---|---|---|",
    ...report.stages.map((s) => `| ${s.subcommand} | ${s.startedAt} | ${s.endedAt ?? "実行中（この計測の後に終わる）"} |`),
    "",
  ].join("\n");
}

// ---- usage（任意のセッション記録と時刻の範囲。作業ディレクトリなしで MIN-33 の前回のような長いセッションの一部を集計する） ----

function usageCommand(args: string[]): Outcome {
  const o = parseOptions(args, ["session", "from", "to", "out"], ["agent", "agent-file"]);
  const session = absolute("session", o.one.get("session"));
  const out = absolute("out", o.one.get("out"));
  const from = o.one.get("from");
  const to = o.one.get("to");
  if (!session || !out || !from || !to) {
    throw new UsageError("使い方: bun review.ts usage --session <親のセッション記録の絶対パス> --from <開始の ISO 時刻> --to <終了の ISO 時刻> --out <記録先のディレクトリの絶対パス> [--agent <担当 ID>]... [--agent-file <担当のセッション記録の絶対パス>]...");
  }
  const [a, b] = [Date.parse(from), Date.parse(to)];
  if (Number.isNaN(a) || Number.isNaN(b) || a >= b) throw new UsageError(`--from と --to は ISO 8601 の時刻で、--from を --to より前にしてください: ${from}〜${to}`);
  const agentFiles = o.many.map((m) =>
    m.key === "agent" ? { agentId: m.value, ...agentSessionPath(session, m.value) } : { agentId: basename(m.value, ".jsonl"), path: absolute("agent-file", m.value) ?? null, missing: "" },
  );
  const agents = agentFiles.map((x) => {
    const file = readSession(x.path, x.missing);
    const m = measure(file, a, b);
    // 担当の時間: 記録の始まり（session の記録。委譲で作られた時刻）から、範囲の最後の応答（最終返答）まで。片付けの記録は含めない
    const start = file.source.sessionAt ?? m.tally?.first ?? null;
    const end = m.tally?.last ?? null;
    return { agentId: x.agentId, ...m, time: { from: start, to: end, seconds: start && end ? secondsBetween(start, end) : null } };
  });
  const parent = measure(readSession(session, ""), a, b);
  mkdirSync(out, { recursive: true });
  const result: Json = { definitions: USAGE_DEFINITIONS, range: { from, to }, parent, agents, agentsTotal: totalOf(agents), out };
  writeFileSync(
    join(out, "usage.md"),
    [
      "# 計測（任意のセッション記録と時刻の範囲）",
      "",
      `- 範囲: ${from} から ${to} まで、${duration(secondsBetween(from, to))}。${USAGE_DEFINITIONS.range}`,
      `- 定義: ${USAGE_DEFINITIONS.usage}。${USAGE_DEFINITIONS.maxContext}。${USAGE_DEFINITIONS.turns}。${USAGE_DEFINITIONS.retries}。${USAGE_DEFINITIONS.missing}。担当の使用量も同じ範囲の応答で数え、担当の時間は記録の始まり（session の記録）から範囲の最後の応答（最終返答）まで（その後の片付けを含めない）`,
      `- 親: ${usageText(parent)}。omp 内部の retry: ${retryText(parent.tally)}。出典: ${sourceText(parent.source)}`,
      `- 担当の使用量の合計: ${tokens(totalOf(agents))}`,
      "",
      ...(agents.length > 0
        ? [
            "| 担当 ID | 記録の始まり | 最後の応答 | 時間 | 使用量 | omp 内部の retry | 出典 |",
            "|---|---|---|---|---|---|---|",
            ...agents.map((x) => `| ${cell(x.agentId)} | ${x.time.from ?? "取得できず"} | ${x.time.to ?? "取得できず"} | ${duration(x.time.seconds)} | ${cell(usageText(x))} | ${cell(retryText(x.tally))} | ${cell(sourceText(x.source))} |`),
          ]
        : ["担当の指定なし"]),
      "",
    ].join("\n"),
  );
  return { work: null, record: join(out, "usage.json"), result };
}

// ---- 振り分け（サブコマンドはここだけで登録する。段階の開始・終了の記録もここで足す） ----

const SUBCOMMANDS: Record<string, (args: string[]) => Outcome> = {
  prepare,
  agent,
  "check-explore": checkExplore,
  "retire-attempt": retireAttempt,
  "refute-input": refuteInput,
  "check-refute": checkRefute,
  "acceptance-records": acceptanceRecords,
  "acceptance-input": acceptanceInput,
  "check-acceptance": checkAcceptance,
  finalize,
  "recheck-ci": recheckCi,
  usage: usageCommand,
};

function emit(result: Json, exitCode: number): never {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(exitCode);
}

function main(argv: string[]): void {
  const [sub = "", ...args] = argv;
  const handler = SUBCOMMANDS[sub];
  if (!handler) emit({ ok: false, code: "INVALID_INPUT", message: `サブコマンドを指定してください: ${Object.keys(SUBCOMMANDS).join("・")}` }, 2);
  try {
    const stage: StageRecord = { subcommand: sub, startedAt: now(), endedAt: null, args };
    currentStage = stage;
    const { work, result, record } = handler(args);
    const out = { ok: true, subcommand: sub, ...result };
    const file = record ?? (work ? join(work, "parent", `${sub}.json`) : null);
    if (file) writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
    if (work) recordStage(work, { ...stage, endedAt: now() });
    emit(out, 0);
  } catch (e) {
    if (e instanceof UsageError) emit({ ok: false, subcommand: sub, code: "INVALID_INPUT", message: e.message }, 2);
    emit({ ok: false, subcommand: sub, code: "UNEXPECTED_ERROR", message: e instanceof Error ? e.message : String(e) }, 1);
  }
}

if (import.meta.main) main(process.argv.slice(2));
