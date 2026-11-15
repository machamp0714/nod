#!/usr/bin/env bun
// nod:code-review の親の定型作業を、段階の境目ごとのサブコマンドで行う（parent.md と付録 parent-details.md）。モデルを起動せず、テスト・Lint・ビルドを実行しない。
// 使い方: bun review.ts <subcommand> --work <作業ディレクトリ W の絶対パス> ...
//   prepare（parent.md 1〜2節）: 対象の固定、秘密候補・空差分の検査、担当用の限定 clone と確認、依存の写しと指紋、共通入力と目録、head を固定した元。
//     --repo <絶対パス> --base <基点の指定> (--mode commit --head <SHA か ref> [--pr <URL>] | --mode local [--untracked <相対パス>]...)
//     [--issue <ID> | --request <絶対パス>... | --request-doc <Document ID>...] [--work <W（存在しないか空）> | --work-root <絶対パス>]
//     評価用の事例: --case <常設データセットの inputs/<case-id> の絶対パス> [--repo <絶対パス>]（nod を使わず case.md と requirements/ から作る）
//     W の既定は $HOME/.local/share/nod/code-reviews/<小文字の uuid>。後の段階は checkIdentity（段階名を受ける）で同一性を確かめ直す
//   agent（parent.md 4節）: --work <W> --role standards|spec|refute --event start|received [--agent-id <担当 ID>]
//     委譲の開始（委譲の直前）と最終返答の受領の時刻・試行の番号・担当 ID を parent/agents.md（と agents.json）に記録する
//   check-explore（5節）: --work <W> --role standards|spec。引き渡し用ファイルの形式と参照、同一性を機械的に検査し、parent/checks.md（と checks.json）に書く
//   retire-attempt（4.1節）: --work <W> --role <役割> --failure invalid|usage-limit|aborted --reason <無効の理由> [--retries <omp 内部の再試行>]
//     最新の試行を parent/attempts/<役割>-<n>/ へ隔離し、同じ入力を確かめて parent/attempts.md（と attempts.json）に書き、委譲し直せるかを返す
//   refute-input（6節）: --work <W>。合格した両探索の引き渡しと共通入力を refute-input/ へ写し、検査時の指紋と照合して parent/fingerprints.md に書く
//   check-refute（7節）: --work <W>。反証の判定本文の形式・参照・集計の一致と同一性を機械的に検査して parent/checks.md に書き、
//     合格なら読み取った構造を parent/refute-structure.json に書く
//   check-boundary（0.1節）: --work <W> [--session <親のセッション記録の絶対パス>（無ければ PI_SESSION_FILE）]。agents.json の各試行の担当の記録
//     （親の記録と同名のディレクトリの <担当 ID>.jsonl）の最初の応答より前から、最初の入力・session_init の systemPrompt・skill-prompt の実パスの事実と
//     混入の目印を取り出して parent/boundary.md（と boundary.json）に書く。本文は写さず、観測できない項目は理由を書く。混入かどうかは親が決める
//   finalize（10節・11節・14節）: --work <W> [--not-run-reason <担当を1つも起動しなかった理由>]
//     [--session <親のセッション記録の絶対パス>（無ければ PI_SESSION_FILE）] [--skill-start <スキルの読み込みの開始の ISO 時刻>]。保存直前の再照合
//     （parent/local-recheck/・requirements-recheck/）、最終状態・点数・確認が残る事項、現在の head と基点の照合（parent/head-check.md）、
//     マージ可否（CI の結果は見ない）、監査 parent/audit.md と結果 parent/report.md の
//     組み立てと保存（Issue があれば監査→結果の順に kind=doc の Document へ保存して照合）、作業ログ・merge-ready、区間の時間と使用量
//     （parent/usage.json・usage.md。usage.json・usage.md には読み取り量と生成量も書く）を行う。評価用の事例では nod へ保存せずラベルも扱わない
//   usage（14節）: --session <親のセッション記録の絶対パス> --from <ISO 時刻> --to <ISO 時刻> --out <記録先の絶対パス> [--agent <担当 ID>]... [--agent-file <絶対パス>]...
//     作業ディレクトリなしで、任意のセッション記録の時刻の範囲（開始を含み終了を含まない）の使用量と読み取り量・生成量を集計し、<out>/usage.json・usage.md に書く（MIN-33 の前回の比較など）
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

// パスのどこかの要素が秘密情報を含み得る名前に当たる（SKILL.md 2節、parent-details.md 2節）
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
  kind: Entry["kind"];
  sha256: string;
}

// 本文/リンク先の指紋に加え、種別も記録・比較する。リンク先の実体は辿らない。
export function fingerprintList(dir: string, exclude?: string): FileHash[] {
  return walkEntries(dir)
    .filter((e) => e.rel !== `./${exclude}`)
    .map((e) => ({ path: e.rel.slice(2), kind: e.kind, sha256: sha256(e.kind === "link" ? `link\0${readlinkSync(e.path)}` : readFileSync(e.path)) }));
}

// 共通入力・引き渡しの指紋一覧（リンクは fingerprintList と同じ種別付きの入力をハッシュする）
export function fileFingerprint(dir: string, exclude?: string): string {
  return fingerprintList(dir, exclude)
    .map((f) => `${f.kind === "link" ? "link " : ""}${f.sha256}  ./${f.path}\n`)
    .join("");
}

// 依存の写しの指紋の一覧（input/deps-files.sha256）: ファイルごとの sha256 の後に、リンクごとの `link <パス> -> <リンク先>`。
// 後の段階では作り直してこのファイルと比べる（担当が写しを変えていないこと）
export function depsFingerprint(depsDir: string): string {
  const entries = walkEntries(depsDir);
  const links = entries.filter((e) => e.kind === "link").map((e) => `link ${e.rel} -> ${readlinkSync(e.path)}\n`);
  return entries.filter((e) => e.kind === "file").map((e) => `${sha256(readFileSync(e.path))}  ${e.rel}\n`).join("") + links.join("");
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

// 担当用の限定 clone の確認（parent-details.md 2.1節）。後の段階でもやり直し、prepare の clone.checks と同じ結果になることを確かめる
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
  repo: string;
  base: string;
  head: string;
  // target.md に写す部分: 最初の「## 」見出しより前の先頭の項目と「## 要求の写し」の節（無ければ空）。ほかの節は元のパスや過去の評価資料を含み得るので写さない
  lead: string;
  requirementsSection: string;
  droppedSections: string[];
  // 事例の manifest.md の表（ファイルの相対パスごとの sha256）
  hashes: Map<string, string>;
  unavailable: string[];
}

function readCase(dir: string): Case {
  const caseFile = join(dir, "case.md");
  const manifestFile = join(dir, "manifest.md");
  if (!existsSync(caseFile) || !existsSync(manifestFile)) throw new UsageError(`--case に case.md と manifest.md がありません: ${dir}`);
  const text = readFileSync(caseFile, "utf8");
  const [lead = "", ...rest] = text.split(/^(?=## )/m);
  const field = (name: string) => new RegExp(`^- ${name}: \`([^\`]+)\``, "m").exec(lead)?.[1];
  const repo = field("対象リポジトリ");
  const base = field("基点の指定");
  const head = field("head");
  const mode = field("mode");
  if (!repo || !base || !head || mode !== "commit") throw new UsageError(`case.md の先頭の項目から対象リポジトリ・基点の指定・head・mode: commit を読めません: ${caseFile}`);
  const sections = rest.map((body) => ({ name: (/^## (.*)$/m.exec(body)?.[1] ?? "").trim(), body }));
  const requirementsSection = sections.find((s) => s.name === "要求の写し")?.body ?? "";
  const droppedSections = sections.filter((s) => s.name !== "要求の写し").map((s) => s.name);
  const manifest = readFileSync(manifestFile, "utf8");
  const hashes = new Map<string, string>();
  for (const m of manifest.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`/gm)) hashes.set(m[1] ?? "", m[2] ?? "");
  const section = /^## 取得できなかった資料と理由\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(manifest)?.[1] ?? "";
  const unavailable = section.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  return { dir, id: basename(dir), repo, base, head, lead, requirementsSection, droppedSections, hashes, unavailable };
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
    // 事例の入力（inputs/<case-id>/）の絶対パス。保存直前の要求資料の再照合が、事例の入力から写し直す
    caseDir: kase ? kase.dir : null,
    // 評価用の事例で target.md に写さなかったもの（親専用）: merge-base に置き換えた元の基点の指定と、写さなかった case.md の節の見出し
    caseTarget: kase ? { base: kase.base, droppedSections: kase.droppedSections } : null,
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
    // case.md の先頭の項目と「要求の写し」の節だけ。元のリポジトリのパス（case.md の対象リポジトリと --repo）は担当へ渡す入力に入れない
    const kept = `${kase.lead.trimEnd()}\n${kase.requirementsSection ? `\n${kase.requirementsSection.trimEnd()}\n` : ""}`;
    target = [kase.repo, repo, realpathSync(repo)]
      .sort((a, b) => b.length - a.length)
      .reduce((text, path) => text.replaceAll(path, "<対象リポジトリ>"), kept)
      .replace(/^- 対象リポジトリ: .*$/m, () => `- 対象リポジトリ: \`${clone}\`\n- 依存の写し: ${depsLine}`)
      .replace(/^- 基点の指定: .*$/m, `- 基点の指定: \`${mergeBase}\``);
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
    [
      "target.md",
      kase
        ? `inputs/${kase.id}/case.md の先頭の項目と「要求の写し」の節だけを写し、対象リポジトリの行を限定 clone に、基点の指定の行を merge-base に、元のリポジトリのパスを <対象リポジトリ> に置き換え、依存の写しの行を足した。ほかの節は写していない（元の基点の指定と写さなかった節の見出しは親専用の記録）（${now()}）`
        : `review.ts prepare が作成（${now()}）`,
    ],
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
    ...inputs.map((i) => `| \`${i.path}\` | \`${i.sha256}\` | ${source(i.path)}（種別 ${i.kind}） |`),
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

export type Role = "standards" | "spec" | "refute";
// 同一性を確かめ直す段階。反証では、その担当への入力の写しも比べる
export type Stage = "explore" | "refute";

const ROLES: Record<Role, { name: string; definition: string; output: string; stage: Stage }> = {
  standards: { name: "Standards 探索", definition: "code-reviewer-standards", output: "handoff.md", stage: "explore" },
  spec: { name: "Spec 探索", definition: "code-reviewer-spec", output: "handoff.md", stage: "explore" },
  refute: { name: "反証", definition: "code-reviewer-refute", output: "verdict.md", stage: "refute" },
};
const STAGE_NAMES: Record<Stage, string> = { explore: "探索", refute: "反証" };
// 段階ごとの担当への入力の写し。写しを作るサブコマンドは、出力（parent/<ディレクトリ名>.json）の files に写しの全ファイルの sha256 を、ready に固定できたかを書く
const STAGE_COPIES: Partial<Record<Stage, string>> = { refute: "refute-input" };

const FAILURES = { invalid: "判定と無関係な無効", "usage-limit": "利用枠の上限", aborted: "利用者による中止" } as const;
type Failure = keyof typeof FAILURES;
const REFUTE_UNFIXED = "反証への入力を固定できず、反証の有効な結果なし";

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
  // 親の手順の検査の番号（探索は5節、反証は7節。parent.md と parent-details.md で同じ番号）
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
  const got = new Map(actual.map((f) => [f.path, `${f.kind}:${f.sha256}`]));
  const want = new Map(expected.map((f) => [f.path, `${f.kind}:${f.sha256}`]));
  const out: string[] = [];
  for (const [path, hash] of want) if (got.get(path) !== hash) out.push(`${path}（記録 ${hash}、今 ${got.get(path) ?? "無い"}）`);
  for (const path of got.keys()) if (!want.has(path)) out.push(`${path}（記録に無いファイル）`);
  return out;
}

// 段階の境目での同一性の確認（parent-details.md 4.1節の2の3、5節の8、7節の6）。共通入力・依存の写し・限定 clone を prepare の記録と比べ、
// 反証では担当への入力の写し（STAGE_COPIES）も、写したときの記録と比べる。結果を parent/identity.md（と identity.json）に足して返す
export function checkIdentity(work: string, stage: Stage, trigger: string): Identity {
  const prep = readPrepared(work);
  const items: IdentityItem[] = [];
  const inputs = compareFiles([...prep.inputs, { path: "manifest.md", kind: "file", sha256: prep.manifestSha256 ?? "" }], fingerprintList(join(work, "input")));
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
    // 反証は、その担当への入力の写し（refute-input）が準備完了を返してから
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

// ---- 探索の引き渡しの機械検査（parent-details.md 5節。本文への禁止情報の混入と担当の返答は親が確かめる（parent.md 5節）） ----

// コード要求の対応表の状態（SKILL.md 5節）
const STATES = new Set(["充足", "未充足", "未確認"]);
// 廃止した対応表の状態・要求資料の分類・確かめる担当。その欄の値として使ったときだけ拒否し、本文の語としては拒否しない
// （候補の判定「基点から存在（対象外）」は別の語彙で、ここには当てない）
const OBSOLETE = ["受け入れ確認担当", "自動チェック担当", "説明", "対象外", "作業手順の規則", "実行しないと分からない"];
// 廃止した未確認の理由
const OBSOLETE_REASON = "要実行確認";
const CODE_FILE_HEADER = ["要求資料", "コード要求"];
// 要求資料ごとのコード要求の値: あり／なし。後ろに括弧1つの注記を付けてもよい（「なし（作業規約は登録されていません）」）。注記は判定に使わない
function codeValue(value: string): string | null {
  const m = /^(あり|なし)(?:\s*[（(](.*)[）)])?$/.exec(value);
  if (!m) return null;
  let depth = 0;
  for (const ch of m[2] ?? "") {
    depth += "（(".includes(ch) ? 1 : "）)".includes(ch) ? -1 : 0;
    if (depth < 0) return null;
  }
  return depth === 0 ? (m[1] ?? null) : null;
}
// 証拠を取得できなかった候補の理由・不足箇所を書いてよい、同じ候補の項目（証拠の欄のほか）
const UNAVAILABLE_REASON_FIELD = "取得できなかった理由";
const UNAVAILABLE_MISSING_FIELD = "不足箇所";
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
// 要求の出典を比べる形（バッククォートと * を外して空白をまとめる）。parent/refute-structure.json の出典もこの形で残す
const norm = (s: string) => plain(s).replace(/\s+/g, " ");
// 欄の値が廃止した語彙そのもの（末尾の句点や括弧の補足は許す）なら、その語
const obsoleteLabel = (v: string) => {
  const n = norm(v).replace(/[。.]+$/, "");
  return OBSOLETE.find((w) => n === w || n.startsWith(`${w}（`) || n.startsWith(`${w}(`)) ?? null;
};

interface Section {
  title: string;
  body: string[];
}

// 見出しの先頭の番号（`1.`・`1)`・`1．`）は表示上の差として外す。見出しの語や項目名の言い換えは読まない
const HEADING_NUMBER = /^\d{1,3}(?:[.)]\s+|．\s*)/;

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
      cur = depth === level ? { title: plain(h[2] ?? "").replace(HEADING_NUMBER, ""), body: [] } : null;
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

type Add = (no: number, message: string) => void;

// 要求資料ごとのコード要求（探索は5節の6、反証は7節の4）: requirements/ の各ファイルに1行ずつ、あり か なし（括弧1つの注記は可）。読み取った一覧（値は あり／なし）を返す
function codeFileViolations(sec: Section | undefined, name: string, prep: Prepared, no: number, add: Add): { path: string; code: string }[] {
  const want = prep.inputs.filter((i) => i.path.startsWith("requirements/")).map((i) => i.path);
  const rows = tableRows(sec?.body ?? [], CODE_FILE_HEADER);
  if (!rows) {
    add(no, `「${name}」に雛形の2列（${CODE_FILE_HEADER.join("・")}）の表が無い`);
    return [];
  }
  const files: { path: string; code: string }[] = [];
  rows.forEach((cells, i) => {
    const path = norm(cells[0] ?? "");
    const code = norm(cells[1] ?? "");
    const label = path || `${i + 1} 行目`;
    if (!want.includes(path)) add(no, `${name}の ${label} が要求資料（requirements/ のファイル）に無い`);
    if (files.some((f) => f.path === path)) add(no, `${name}に ${label} が重複している`);
    const old = obsoleteLabel(code);
    const value = codeValue(code);
    if (old) add(no, `${name}の ${label} に廃止した分類「${old}」を使っている（あり／なしだけ）`);
    else if (!value) add(no, `${name}の ${label} のコード要求「${code}」があり／なし（後ろに括弧1つの注記は可）のどちらでもない`);
    files.push({ path, code: value ?? code });
  });
  for (const w of want) if (!files.some((f) => f.path === w)) add(no, `${w} のコード要求あり／なしが${name}に無い`);
  return files;
}

// 対応表の1行の状態と不足理由（探索は5節の6、反証は7節の4）: 状態は 充足・未充足・未確認 だけ。廃止した状態と、未確認の理由「要実行確認」を拒否する
function rowStateViolations(label: string, status: string, reason: string, no: number, add: Add): void {
  const old = obsoleteLabel(status);
  if (old) add(no, `${label} の状態に廃止した「${old}」を使っている（充足・未充足・未確認だけ）`);
  else if (!STATES.has(status)) add(no, `${label} の状態「${status}」が語彙（充足・未充足・未確認）に無い`);
  if (status === "未確認" && reason.includes(OBSOLETE_REASON)) add(no, `${label} の未確認の理由に廃止した「${OBSOLETE_REASON}」を使っている`);
}

// 担当と対象の節（探索は5節の3、反証は7節の2）: 必須の項目、委譲した役割・定義名、target.md と一致する対象版、終了状態
function targetViolations(target: Section | undefined, names: readonly string[], role: Role, prep: Prepared, no: number, add: Add, states = /完了|未確認/): void {
  const r = ROLES[role];
  if (!target) add(no, "「担当と対象」の節が無い");
  const versionFields = (target?.body ?? []).filter((line) => /^\S/.test(line) && plain(FIELD.exec(line)?.[1] ?? "") === "対象版");
  if (versionFields.length > 1) add(no, "担当と対象の「対象版」が重複している（同じ値でも1項目だけ）");
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
  if (secs.filter((s) => s.title.startsWith("担当と対象")).length > 1) add(3, "「担当と対象」の節が重複している（同じ内容でも1節だけ）");
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
    // 理由と不足箇所は、証拠の欄か、同じ候補の明示した項目（取得できなかった理由・不足箇所）にあるものだけを数える。ほかの欄・候補・節の語は数えない
    const evidence = cf.get("証拠") ?? "";
    const reason = evidence.includes("理由") || !!cf.get(UNAVAILABLE_REASON_FIELD);
    const lack = evidence.includes("不足") || !!cf.get(UNAVAILABLE_MISSING_FIELD);
    if (/取得できな|取得できず/.test(evidence) && !(reason && lack))
      add(4, `${id} は証拠を取得できなかった候補だが、証拠の欄か同じ候補の「${UNAVAILABLE_REASON_FIELD}」「${UNAVAILABLE_MISSING_FIELD}」の項目に理由と不足箇所が無い`);
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

  // 6: 要求資料ごとのコード要求あり／なしと、コード要求の対応表（列は見出しと各行の出典・状態・候補ID の位置で読む。コード要求0件なら空の表）
  codeFileViolations(section("要求資料ごとのコード要求"), "要求資料ごとのコード要求", prep, 6, add);
  const rows = tableRows(section("コード要求の対応表")?.body ?? [], TABLE_HEADER);
  if (!rows) add(6, `「コード要求の対応表」に雛形の4列（${TABLE_HEADER.join("・")}）の表が無い（コード要求0件なら行の無い表）`);
  (rows ?? []).forEach((cells, i) => {
    if (cells.length < 4) return add(6, `対応表の ${i + 1} 行目の列が足りない（出典・状態・候補ID を読み取れない）`);
    const status = plain(cells[1] ?? "");
    const label = plain(cells[0] ?? "") || `${i + 1} 行目`;
    rowStateViolations(label, status, cells.slice(2, -1).join(" | "), 6, add);
    const refs = (cells[cells.length - 1] ?? "").match(/[A-Za-z]+-\d+/g) ?? [];
    if ((status === "未充足" || status === "未確認") && refs.length === 0) add(6, `${label} は${status}だが候補 ID が無い`);
    for (const ref of refs) if (!ids.has(ref)) add(6, `${label} が参照する候補 ${ref} が候補一覧に無い`);
  });
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
    ...(role === "spec" ? ([[6, "要求資料ごとのコード要求あり／なし、コード要求の対応表の4列・状態の語彙（充足・未充足・未確認。0件なら空の表）・廃止した状態と理由の拒否・候補 ID の参照"]] as [number, string][]) : []),
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

// ---- 無効な試行の隔離と再委譲の可否（parent-details.md 4.1節。失敗の分類と委譲は親） ----

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

// ---- 反証への入力（parent.md・parent-details.md 6節） ----

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
    ...passed.map((p) => ({ path: `${p.role}-handoff.md`, kind: "file", sha256: p.check.sha256 ?? "", source: `${p.role}/handoff.md（check-explore で検査した試行 ${p.check.attempt}）` })),
    ...prep.inputs.map((i) => ({ ...i, source: `input/${i.path}（prepare の記録）` })),
    { path: "manifest.md", kind: "file", sha256: prep.manifestSha256 ?? "", source: "input/manifest.md（prepare の記録）" },
  ];
  const files = fingerprintList(dest);
  const got = new Map(files.map((f) => [f.path, f]));
  const comparison = [
    ...expected.map((e) => ({ ...e, copied: got.get(e.path)?.sha256 ?? null, copiedKind: got.get(e.path)?.kind ?? null, ok: got.get(e.path)?.sha256 === e.sha256 && got.get(e.path)?.kind === e.kind })),
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

// ---- 反証の判定本文の機械検査（parent-details.md 7節。親は判定本文を通読しない） ----

const VERDICTS = new Set(["要対応", "棄却", "未確認", "基点から存在（対象外）", "任意"]);
const AXES = ["Standards", "Spec"] as const;
type Axis = (typeof AXES)[number];
const REFUTE_TARGET_FIELDS = ["役割", "定義名", "対象版", "受け取った入力", "依存の写し", "終了状態"];
const DECISION_HEADER = ["候補ID", "発見者の区分", "判定", "影響度", "同一原因", "根拠"];
const REMOVED_HEADER = ["要求の出典", "理由"];
const UNCONFIRMED_HEADER = ["要求の出典または候補ID", "軸", "種別", "理由", "確かめる担当", "不足箇所"];
const UNCONFIRMED_KINDS = new Set(["候補", "要求", "要求間の矛盾"]);
const NO_FINDING = "反証で追加した発見なし";
const IMPACT = /^([0-4])(?!\d)/;
// 節の「なし」の明示（行頭の「なし」）
const NONE = /^(?:[-*+]\s*)?なし(?:$|[\s。.、（(])/;
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

// コード要求の対応表（確定）の1行。added は反証が足した行（証拠または不足理由の欄の先頭の「（追加）」の印。印は検査しない）
export interface TableRow {
  source: string;
  status: string;
  evidence: string;
  candidates: string[];
  added: boolean;
}

// 表から除いた行の節の1行（Spec 探索の対応表から反証が外した行の出典と1行の理由）
export interface RemovedRow {
  source: string;
  reason: string;
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

interface RefuteParsed {
  axes: Record<Axis, { required: number; unconfirmed: number }>;
  decisions: Decision[];
  required: RequiredItem[];
  files: { path: string; code: string }[];
  table: TableRow[];
  removed: RemovedRow[];
  unconfirmed: UnconfirmedRow[];
}

// check-refute に合格した判定本文から読み取った構造（parent/refute-structure.json）。点数・確認が残る事項の算出はこれを読む
export interface RefuteStructure extends RefuteParsed {
  attempt: number;
  agentId: string | null;
  file: string;
  sha256: string;
  checkedAt: string;
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
  const table = sectionsOf(text.split("\n"), 2).find((s) => s.title.startsWith("コード要求の対応表"));
  return (tableRows(table?.body ?? [], TABLE_HEADER) ?? []).map((c) => norm(c[0] ?? ""));
}

function refuteViolations(text: string, prep: Prepared, handoffs: { standards: string; spec: string }, add: Add): RefuteParsed {
  const lines = text.split("\n");
  const secs = sectionsOf(lines, 2);
  const section = (name: string) => secs.find((s) => s.title.startsWith(name));
  // 判定本文が挙げる候補 ID（反証で追加した REF-<n> が採否一覧にあるかを確かめる）
  const mentioned: string[] = [];

  // 2: 担当と対象
  if (secs.filter((s) => s.title.startsWith("担当と対象")).length > 1) add(2, "「担当と対象」の節が重複している（同じ内容でも1節だけ）");
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
    const missing = [...CANDIDATE_FIELDS, "契約の出典", "関連する要求・契約", "反証の判定理由"].filter((name) => !plain(f.get(name) ?? ""));
    if (missing.length > 0) add(3, `要対応 ${heading} の必須項目が無いか空（${missing.join("・")}）`);
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
    if (impacts.length === 0) add(3, `要対応 ${heading} に採否一覧で要対応の候補が無い`);
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

  // 4: 要求資料ごとのコード要求、コード要求の対応表（確定。コード要求0件なら空の表）、表から除いた行、Spec 探索の対応表の各行の行き先
  const files = codeFileViolations(section("要求資料ごとのコード要求"), "要求資料ごとのコード要求（確定）", prep, 4, add);
  const rows = tableRows(section("コード要求の対応表")?.body ?? [], TABLE_HEADER);
  const table: TableRow[] = [];
  if (!rows) add(4, `「コード要求の対応表（確定）」に雛形の4列（${TABLE_HEADER.join("・")}）の表が無い（コード要求0件なら行の無い表）`);
  (rows ?? []).forEach((cells, i) => {
    if (cells.length < 4) return add(4, `対応表の ${i + 1} 行目の列が足りない（出典・状態・候補ID を読み取れない）`);
    const source = norm(cells[0] ?? "");
    const status = plain(cells[1] ?? "");
    const evidence = norm(cells.slice(2, -1).join(" | "));
    const label = source || `${i + 1} 行目`;
    const ids = candidateIds(cells[cells.length - 1] ?? "");
    mentioned.push(...ids);
    if (table.some((t) => t.source === source)) add(4, `対応表の要求の出典 ${label} が重複している`);
    rowStateViolations(label, status, evidence, 4, add);
    if (status === "未充足" && !ids.some((id) => decided.get(id)?.verdict === "要対応")) add(4, `${label} は未充足だが、採否一覧で要対応の候補 ID が無い`);
    for (const id of ids) if (!decided.has(id)) add(4, `${label} が参照する候補 ${id} が採否一覧に無い`);
    table.push({ source, status, evidence, candidates: ids, added: evidence.startsWith("（追加）") });
  });
  const removedSection = section("表から除いた行");
  const out = sectionTable(removedSection, REMOVED_HEADER);
  if (!removedSection) add(4, "「表から除いた行」の節が無い");
  else if (out.rows.length === 0 && !out.none) add(4, `「表から除いた行」に雛形の2列（${REMOVED_HEADER.join("・")}）の表も「なし」の明示も無い`);
  const removed: RemovedRow[] = [];
  out.rows.forEach((cells, i) => {
    const source = norm(cells[0] ?? "");
    const reason = norm(cells.slice(1).join(" | "));
    const label = source || `${i + 1} 行目`;
    if (!source || !reason) add(4, `表から除いた行の ${label} に出典か理由が無い`);
    const old = obsoleteLabel(reason);
    if (old) add(4, `表から除いた行の ${label} の理由に廃止した分類「${old}」を使っている（1行の理由を書く）`);
    removed.push({ source, reason });
  });
  const confirmed = new Set([...table.map((t) => t.source), ...removed.map((r) => r.source)]);
  for (const s of handoffSources(handoffs.spec)) if (!confirmed.has(s)) add(4, `Spec 探索の対応表の行 ${s} が、確定した対応表にも表から除いた行にも無い`);

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
    const oldOwner = obsoleteLabel(row.owner);
    if (oldOwner) add(5, `未確認の ${label} の確かめる担当に廃止した「${oldOwner}」を使っている`);
    if (row.reason.includes(OBSOLETE_REASON)) add(5, `未確認の ${label} の理由に廃止した「${OBSOLETE_REASON}」を使っている`);
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

  return { axes, decisions, required, files, table, removed, unconfirmed };
}

function checkRefute(args: string[]): Outcome {
  const o = parseOptions(args, ["work"], []);
  const { work, prep } = loadWork(o);
  if (existsSync(join(work, "parent/finalize.json"))) throw new UsageError("finalize の後は、反証の結果を検査し直しません");
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
  for (const i of identity.items) if (!i.ok) add(6, `${i.name}: ${i.detail}`);
  const names: [number, string][] = [
    [1, `指定したパスに ${r.output} がある`],
    [2, "役割・定義名・対象版・受け取った入力・依存の写し・終了状態"],
    [3, "採否一覧に両探索の全候補 ID と反証で追加した発見、判定の語彙と根拠、要対応の影響度 0〜4、要対応の節と採否一覧（同一候補の判定・同一原因の集約と影響度）の一致"],
    [4, "要求資料ごとのコード要求あり／なし、コード要求の対応表の4列・状態の語彙（充足・未充足・未確認。0件なら空の表）・廃止した状態と理由の拒否・未充足の行の要対応・候補 ID の参照、表から除いた行の出典と理由、Spec 探索の対応表の各行が確定した対応表か表から除いた行にあること"],
    [5, "反証で追加した発見の明示、軸ごとの要対応と未確認の件数と個別の判定の一致、未確認と理由の表（未確認の行と候補がすべてある・廃止した担当と理由の拒否）、判断を見送った事項"],
    [6, "refute-input/ の写し・共通入力・依存の写し・限定 clone の同一性"],
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
  // 構造は、合格した最新の判定本文からだけ残す
  const structureFile = join(work, "parent/refute-structure.json");
  rmSync(structureFile, { force: true });
  if (!record.valid || !parsed || body === null) return { work, result: { ...record, structure: null } };
  const structure: RefuteStructure = { attempt: attempt.attempt, agentId: attempt.agentId, file, sha256: sha256(body), checkedAt, ...parsed };
  writeFileSync(structureFile, `${JSON.stringify(structure, null, 2)}\n`);
  return { work, result: { ...record, structure: "parent/refute-structure.json" } };
}

// ---- 担当の入力境界（parent.md 0.1節。担当の記録の最初の応答より前の文脈から事実だけを取り出し、混入かどうかの判断は親に残す） ----

type BoundaryKey = "first-input" | "system-prompt" | "skill-prompt";

// 0.1節で親が確かめる3つ（担当の最初の入力、session_init の systemPrompt、skill-prompt の実パス）と一対一に対応する
const BOUNDARY_ITEMS: Record<BoundaryKey, string> = {
  "first-input": "最初の入力（依頼本文）",
  "system-prompt": "session_init の systemPrompt",
  "skill-prompt": "skill-prompt の実パス",
};

export interface BoundaryItem {
  key: BoundaryKey;
  name: string;
  // 記録から観測できた。false なら reason に理由を書き、目印が無いことと読み替えない
  observed: boolean;
  // 元の作業ツリーの規約・プロジェクトのスキル一覧などの混入を疑う目印（事実だけ。違反かどうかは親が決める）
  marks: string[];
  reason: string | null;
  // 取り出した事実（本文は写さず、sha256・大きさ・項目の有無だけ）
  facts: Json;
  // 観測の限界
  limits: string[];
}

export interface BoundaryAttempt {
  role: Role;
  roleName: string;
  attempt: number;
  agentId: string | null;
  source: { path: string | null; sha256: string | null; unavailable: string | null };
  items: BoundaryItem[];
}

// 依頼本文の雛形の項目（4節・6節）。行頭の「項目: 値」を項目として読み、箇条の行（「- 」で始まる）は読まない
const REQUEST_FIELDS: Record<Stage, string[]> = {
  explore: ["役割", "作業ディレクトリ", "読んでよい入力", "書いてよい場所", "出力"],
  refute: ["役割", "読んでよい入力（次のファイルだけ）", "書いてよい場所", "出力"],
};
const REQUEST_FIELD = /^(?![-*+]\s)([^\s:：][^:：]{0,40}?)\s*[:：][ \t]*(.*)$/;
// omp が作業ディレクトリのプロジェクトのスキルを読む場所（作業ツリーの <場所>/<名前>/SKILL.md）
const PROJECT_SKILL_DIRS = [".omp/skills", ".claude/skills", ".agents/skills", ".codex/skills"];

// 元のリポジトリのパス（そのままと実パス）が、パスの区切りの位置で現れるか
function mentionsRepo(text: string, origins: string[]): boolean {
  return origins.some((o) => new RegExp(`${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`).test(text));
}

// 規約ファイルの混入の目印（omp が自動で読み込んだ規約ファイルは <repo-rules> と <file path=…> で入る）と、元のリポジトリのパス
function contextMarks(text: string, origins: string[]): { marks: string[]; repoRules: boolean; contextFiles: string[]; repoPath: boolean } {
  const repoRules = text.includes("<repo-rules>");
  const contextFiles = [...text.matchAll(/<file path="([^"]+)"/g)].map((m) => m[1] ?? "");
  const repoPath = mentionsRepo(text, origins);
  const marks = [
    ...(repoRules ? ["<repo-rules> がある"] : []),
    ...(contextFiles.length > 0 ? [`規約ファイル（<file path=…>）がある: ${contextFiles.join("・")}`] : []),
    ...(repoPath ? [`元のリポジトリのパス（${origins[0]}）がある`] : []),
  ];
  return { marks, repoRules, contextFiles, repoPath };
}

// 元の作業ツリーのプロジェクトのスキルの名前（frontmatter の name、無ければディレクトリ名）
function projectSkills(repo: string): string[] {
  const names: string[] = [];
  for (const dir of PROJECT_SKILL_DIRS.map((d) => join(repo, d))) {
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name, "SKILL.md");
      if (!existsSync(file)) continue;
      names.push(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(readFileSync(file, "utf8").split(/^---\s*$/m)[1] ?? "")?.[1] ?? name);
    }
  }
  return names;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// 観測できなかった項目（目印は空のまま。目印が無いこととは読み替えない）
function unobservedItem(key: BoundaryKey, reason: string): BoundaryItem {
  return { key, name: BOUNDARY_ITEMS[key], observed: false, marks: [], reason, facts: {}, limits: [] };
}

// 担当の記録のうち最初の assistant の応答より前の行だけ（書込ペイロードや反証の本文は、それより後にしか現れない）
function initialContext(lines: string[]): Json[] {
  const out: Json[] = [];
  for (const line of lines) {
    let j: Json;
    try {
      j = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    if (j.type === "message" && (j.message as Json | undefined)?.role === "assistant") break;
    out.push(j);
  }
  return out;
}

function boundaryItems(rows: Json[], role: Role, prep: Prepared, skillFile: string, work: string): BoundaryItem[] {
  const origins = [...new Set([prep.repo, realOrSelf(prep.repo)])];
  const item = (key: BoundaryKey, facts: Json, marks: string[], limits: string[] = []): BoundaryItem => ({ key, name: BOUNDARY_ITEMS[key], observed: true, marks, reason: null, facts, limits });
  const items: BoundaryItem[] = [];

  const user = rows.find((j) => j.type === "message" && (j.message as Json | undefined)?.role === "user");
  if (!user) items.push(unobservedItem("first-input", "最初の応答より前に user の入力の記録が無い"));
  else {
    const content = (user.message as Json).content;
    const text = typeof content === "string" ? content : (Array.isArray(content) ? (content as Json[]) : []).map((c) => (c?.type === "text" && typeof c.text === "string" ? c.text : "")).join("");
    const fields: { name: string; value: string }[] = [];
    const nonTemplateLines: number[] = [];
    let refuteInputs = false;
    for (const [index, line] of text.split("\n").entries()) {
      if (line.trim() === "" || (index === 0 && line === "Complete assignment thoroughly:")) continue;
      const m = REQUEST_FIELD.exec(line);
      if (m) {
        fields.push({ name: m[1] ?? "", value: m[2] ?? "" });
        refuteInputs = role === "refute" && m[1] === "読んでよい入力（次のファイルだけ）";
      } else if (
        !refuteInputs ||
        !(
          line.startsWith(`- ${join(work, "refute-input")}/`) ||
          line === `- 対象リポジトリ ${join(work, "repo")}（target.md の担当用の限定 clone）` ||
          line === `- 依存の写し ${join(work, "deps")}/（準備できたときだけ）`
        )
      ) {
        nonTemplateLines.push(index + 1);
      }
    }
    const template = REQUEST_FIELDS[ROLES[role].stage];
    const roleValue = fields.find((f) => f.name === "役割")?.value.trim() ?? null;
    const missing = template.filter((t) => !fields.some((f) => f.name === t));
    const extra = [...new Set(fields.filter((f) => f.value.trim() !== "" && !template.includes(f.name)).map((f) => f.name))];
    const ctx = contextMarks(text, origins);
    const marks = [
      ...(roleValue !== null && roleValue !== ROLES[role].name ? [`役割の値が委譲した役割（${ROLES[role].name}）と違う: ${roleValue}`] : []),
      ...(missing.length > 0 ? [`雛形の項目が無い: ${missing.join("・")}`] : []),
      ...(extra.length > 0 ? [`雛形に無い項目: ${extra.join("・")}`] : []),
      ...(nonTemplateLines.length > 0 ? [`雛形の項目外の行: ${nonTemplateLines.join(", ")}`] : []),
      ...ctx.marks,
    ];
    const nonText = Array.isArray(content) ? (content as Json[]).filter((c) => c?.type !== "text").length : 0;
    items.push(
      item("first-input", { sha256: sha256(text), bytes: utf8(text), role: roleValue, missing, extra, nonTemplateLines, repoRules: ctx.repoRules, contextFiles: ctx.contextFiles, repoPath: ctx.repoPath, nonTextBlocks: nonText }, marks, nonText > 0 ? [`text 以外のブロック ${nonText} 件は調べていない`] : []),
    );
  }

  const init = rows.find((j) => j.type === "session_init");
  const prompt = init?.systemPrompt;
  const parts = typeof prompt === "string" ? [prompt] : Array.isArray(prompt) && prompt.every((p) => typeof p === "string") ? (prompt as string[]) : null;
  if (!init) items.push(unobservedItem("system-prompt", "session_init の記録が無い"));
  else if (!parts) items.push(unobservedItem("system-prompt", "session_init に文字列の systemPrompt が無い"));
  else {
    const text = parts.join("\n");
    const ctx = contextMarks(text, origins);
    const block = /<skills>\n([\s\S]*?)\n?<\/skills>/.exec(text)?.[1] ?? null;
    const listed = block === null ? [] : [...block.matchAll(/^- ([^:\n]+):/gm)].map((m) => (m[1] ?? "").trim());
    const local = projectSkills(prep.repo);
    const shared = local.filter((n) => listed.some((l) => l === n || l.endsWith(`/${n}`) || l.endsWith(`:${n}`)));
    const cwd = rows.find((j) => j.type === "session")?.cwd;
    const cwdText = typeof cwd === "string" ? cwd : null;
    const cwdInRepo = cwdText !== null && origins.some((o) => cwdText === o || cwdText.startsWith(`${o}/`));
    const marks = [
      ...ctx.marks,
      ...(shared.length > 0 ? [`元の作業ツリーのプロジェクトのスキルの名前がスキル一覧にある: ${shared.join("・")}`] : []),
      ...(cwdInRepo ? [`担当の作業ディレクトリ（session の cwd）が元のリポジトリの中: ${cwdText}`] : []),
    ];
    const limits = [
      "スキル一覧は名前で照合し、同名のユーザーのスキルとは区別できない",
      ...(local.length === 0 ? [`元の作業ツリーに ${PROJECT_SKILL_DIRS.join("・")} のスキルが無く、スキル一覧を名前で照合していない`] : []),
      ...(block === null ? ["systemPrompt に <skills> の一覧が無い"] : []),
      ...(cwdText === null ? ["session の記録に cwd が無い"] : []),
    ];
    items.push(
      item("system-prompt", { sha256: sha256(text), bytes: utf8(text), parts: parts.length, repoRules: ctx.repoRules, contextFiles: ctx.contextFiles, repoPath: ctx.repoPath, skills: block === null ? null : listed.length, projectSkills: local, listedProjectSkills: shared, cwd: cwdText, cwdInRepo }, marks, limits),
    );
  }

  const own = realOrSelf(skillFile);
  const prompts = rows
    .filter((j) => j.type === "custom_message" && j.customType === "skill-prompt")
    .map((j) => {
      const details = j.details !== null && typeof j.details === "object" ? (j.details as Json) : {};
      const path = typeof details.path === "string" ? details.path : null;
      const content = typeof j.content === "string" ? j.content : "";
      return { name: typeof details.name === "string" ? details.name : null, path, sha256: sha256(content), bytes: utf8(content), sameSkill: path !== null && realOrSelf(path) === own };
    });
  const marks = prompts.length === 0 ? ["skill-prompt の記録が無い"] : prompts.filter((x) => !x.sameSkill).map((x) => `このスクリプトのスキルと違う SKILL.md: ${x.path ?? "パスの記録なし"}`);
  items.push(item("skill-prompt", { skill: skillFile, paths: prompts }, marks));
  return items;
}

function boundaryFacts(i: BoundaryItem): string {
  const f = i.facts;
  const list = (v: unknown) => (Array.isArray(v) && v.length > 0 ? v.join("・") : "なし");
  if (i.key === "first-input") return `sha256 ${f.sha256}、${f.bytes} バイト、役割 ${f.role ?? "なし"}、雛形の項目の欠落 ${list(f.missing)}、雛形に無い項目 ${list(f.extra)}、雛形の項目外の行 ${list(f.nonTemplateLines)}`;
  if (i.key === "system-prompt") {
    return `sha256 ${f.sha256}（${f.parts} 個の部分を改行でつないだもの）、${f.bytes} バイト、<repo-rules> ${f.repoRules ? "あり" : "なし"}、規約ファイル ${list(f.contextFiles)}、スキル一覧 ${f.skills ?? "なし"} 件、元の作業ツリーのプロジェクトのスキル ${list(f.projectSkills)}、session の cwd ${f.cwd ?? "記録なし"}`;
  }
  const paths = (f.paths as { path: string | null; sha256: string; bytes: number; sameSkill: boolean }[]) ?? [];
  return paths.length === 0 ? "記録なし" : paths.map((x) => `${x.path ?? "パスの記録なし"}（本文 sha256 ${x.sha256}、${x.bytes} バイト、このスクリプトのスキル: ${x.sameSkill ? "同じ" : "違う"}）`).join("・");
}

function renderBoundary(session: ParentSession, skillFile: string, attempts: BoundaryAttempt[]): string {
  const out = [
    "# 担当の入力境界",
    "",
    "review.ts check-boundary が、各試行の担当のセッション記録（親の記録と同名のディレクトリの `<担当 ID>.jsonl`）のうち、最初の応答より前の記録だけを読んで取り出した事実（parent.md 0.1節）。",
    "依頼本文・systemPrompt・skill-prompt の本文は写さず、sha256 と大きさ、項目の有無だけを書く。書込ペイロードと反証の本文は読まない。",
    "目印は元の作業ツリーの規約・プロジェクトのスキル一覧などの混入を疑う事実で、混入かどうかは親が決める。観測できなかった項目は「観測できず」と理由を書き、目印が無いこととは読み替えない。",
    "",
    `- 親のセッション記録: ${session.path ?? `観測できず（${session.missing}）`}（${session.origin}）`,
    `- このスクリプトのスキルの SKILL.md: ${skillFile}`,
    "",
  ];
  for (const a of attempts) {
    out.push(`## ${a.roleName} 試行 ${a.attempt}（担当 ID ${a.agentId ?? "不明"}）`, "");
    out.push(`- 担当の記録: ${a.source.unavailable ? `観測できず（${a.source.unavailable}）` : `${a.source.path}（sha256 \`${a.source.sha256}\`）`}`, "");
    out.push("| 項目 | 観測 | 目印 | 事実 | 観測の限界 |", "|---|---|---|---|---|");
    out.push(
      ...a.items.map(
        (i) =>
          `| ${i.name} | ${i.observed ? "観測した" : `観測できず（${cell(i.reason ?? "")}）`} | ${i.observed ? cell(i.marks.join("・") || "なし") : "観測できず"} | ${i.observed ? cell(boundaryFacts(i)) : "-"} | ${cell(i.limits.join("・") || "-")} |`,
      ),
      "",
    );
  }
  return out.join("\n");
}

function checkBoundary(args: string[]): Outcome {
  const o = parseOptions(args, ["work", "session"], []);
  const { work, prep } = loadWork(o);
  const session = parentSession(absolute("session", o.one.get("session")), "check-boundary の --session");
  const agents = loadList<AgentRecord>(work, "agents");
  if (agents.length === 0) throw new UsageError("委譲が記録されていません（agent --event start で記録してから）");
  const skillFile = join(import.meta.dir, "../SKILL.md");
  const attempts: BoundaryAttempt[] = agents.map((a) => {
    const where = agentSessionPath(session.path, a.agentId);
    const head = { role: a.role, roleName: a.roleName, attempt: a.attempt, agentId: a.agentId };
    const fail = (reason: string, path: string | null): BoundaryAttempt => ({
      ...head,
      source: { path, sha256: null, unavailable: reason },
      items: (Object.keys(BOUNDARY_ITEMS) as BoundaryKey[]).map((key) => unobservedItem(key, reason)),
    });
    if (!where.path) return fail(session.path ? where.missing : session.missing, null);
    if (!existsSync(where.path)) return fail(`記録が無い（${where.path}）`, where.path);
    let data: Buffer;
    try {
      data = readFileSync(where.path);
    } catch (e) {
      return fail(`記録を読めない（${where.path}: ${e instanceof Error ? e.message : String(e)}）`, where.path);
    }
    const rows = initialContext(data.toString("utf8").split("\n").filter((l) => l.trim() !== ""));
    return { ...head, source: { path: where.path, sha256: sha256(data), unavailable: null }, items: boundaryItems(rows, a.role, prep, skillFile, work) };
  });
  const sessionView = { path: session.path, origin: session.origin, unavailable: session.path ? null : session.missing };
  writeFileSync(join(work, "parent/boundary.json"), `${JSON.stringify({ checkedAt: now(), session: sessionView, repo: prep.repo, skill: skillFile, attempts }, null, 2)}\n`);
  writeFileSync(join(work, "parent/boundary.md"), renderBoundary(session, skillFile, attempts));
  return {
    work,
    result: {
      session: sessionView,
      attempts: attempts.map((a) => ({ ...a, items: a.items.map(({ key, name, observed, marks, reason }) => ({ key, name, observed, marks, reason })) })),
      marked: attempts.filter((a) => a.items.some((i) => i.marks.length > 0)).length,
      unobserved: attempts.filter((a) => a.items.some((i) => !i.observed)).length,
      record: join(work, "parent/boundary.md"),
    },
  };
}

// ---- 最終状態・点数・確認が残る事項・保存直前の再照合・マージ可否（parent-details.md 10節） ----

type Status = "完了" | "未完了" | "未実施";
const MERGE_OK = "可（人のレビューなしでマージ可）";
// mode: local はマージ可否の対象外で、常にこの理由で不可
const LOCAL_MERGE = "未コミット変更のレビュー（mode: local）。commit 後に新しいレビューが要る";
// merge-ready の操作の作業ログ（--kind progress）の本文の先頭
const MERGE_READY_LOG = "[merge-ready]";
const SEVERITY = ["Critical（致命的）", "Critical（致命的）", "High（高）", "Medium（中）", "Low（低）"];

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

interface ReviewState {
  status: Status;
  reason: string | null;
  refute: RefuteStructure | null;
}

// 最終状態（SKILL.md 6節、parent-details.md 10節の4）。必要な担当の有効な結果の有無だけで決め、判定の中身・未確認・保存前の変化では変えない
function reviewStatus(work: string, prep: Prepared, notRunReason: string | undefined): ReviewState {
  const agents = loadList<AgentRecord>(work, "agents");
  const retired = loadList<AttemptRecord>(work, "attempts");
  const checks = loadList<CheckRecord>(work, "checks");
  const none: ReviewState = { status: "未実施", reason: null, refute: null };
  if (notRunReason !== undefined && agents.length > 0) throw new UsageError("--not-run-reason は担当を1つも起動しなかったときだけ使います");
  if (!prep.ready) return { ...none, reason: prep.reason ?? "準備できなかった" };
  if (agents.length === 0) return { ...none, reason: notRunReason ? `${notRunReason}（担当を1つも起動しなかった）` : "担当を1つも起動しなかった" };
  const retiredOf = (a: AgentRecord) => retired.find((x) => x.role === a.role && x.attempt === a.attempt);
  const latest = (role: Role) => agents.filter((a) => a.role === role).at(-1);
  for (const role of Object.keys(ROLES) as Role[]) {
    const last = latest(role);
    if (!last || retiredOf(last)) continue;
    if (!last.receivedAt) throw new UsageError(`${last.roleName}の試行 ${last.attempt} の最終返答の受領が記録されていません（終了を待って agent --event received で記録するか、retire-attempt で隔離してから）`);
    const command = role === "refute" ? "check-refute" : `check-explore --role ${role}`;
    if (!checks.some((c) => c.role === role && c.attempt === last.attempt)) throw new UsageError(`${last.roleName}の試行 ${last.attempt} を検査していません（${command}）`);
  }
  const refute = readRecord<RefuteStructure>(join(work, "parent/refute-structure.json"));
  const valid = (role: Role): boolean => {
    const last = latest(role);
    const check = last && !retiredOf(last) ? checks.filter((c) => c.role === role && c.attempt === last.attempt).at(-1) : undefined;
    if (!last || !check?.valid) return false;
    if (role === "refute") return refute?.attempt === last.attempt && refute.sha256 === check.sha256;
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
          : null;
  return { status: reason === null ? "完了" : "未完了", reason, refute: refuteOk };
}

// 判定本文の未確認と理由の表からの確認が残る事項（parent-details.md 10節の6）。コードレベルで結論を出せない未確認だけが、理由と不足箇所のまま入る
function verdictRemaining(refute: RefuteStructure | null): Remaining[] {
  return (refute?.unconfirmed ?? []).map((u) => ({ ref: u.ref, owner: u.owner, reason: `${u.reason}（${u.kind}、軸 ${u.axis}、不足箇所: ${u.missing}）`, from: "反証の未確認と理由" }));
}

interface RequirementsRecheck {
  at: string;
  dir: string;
  compared: string[];
  changed: { path: string; before: string | null; after: string | null }[];
  unavailable: { item: string; reason: string }[];
  note: string | null;
}

// 10節の2: 要求の本文・資料だけを prepare と同じ方法で dir へ取り直し、input/requirements/ と sha256 で比べる（評価用は事例の入力から）
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
  if (prep.issue) {
    // 本文を取得できない新規specはファイル比較に現れない。Issueから観測した集合も比べる。
    const [oldIds, newIds] = [join(work, "parent/issue-snapshot.json"), join(dir, "issue-snapshot.json")].map((path) => {
      try {
        const snapshot = readRecord<{ title?: unknown; documents?: DocRow[] }>(path);
        if (!snapshot || typeof snapshot.title !== "string") return null;
        return (Array.isArray(snapshot.documents) ? snapshot.documents : []).filter((d) => d.kind === "spec").map((d) => d.id).sort((a, b) => a - b);
      } catch (error) {
        // snapshotは外部コマンドの生出力。非JSONでも取得不能を記録し、不可判定・保存・ラベル解除へ進む。
        req.unavailable.push({ item: `kind=spec の集合（${path}）`, reason: `Issue の取得記録を解析できない（${String(error)}）` });
        return null;
      }
    });
    if (oldIds && newIds) {
      const missingChange = [...oldIds, ...newIds].some((id) => oldIds.includes(id) !== newIds.includes(id) && !changed.some((c) => c.path === `requirements/spec-${id}.md`));
      if (missingChange) {
        changed.push({ path: "requirements/kind=spec", before: sha256(JSON.stringify(oldIds)), after: sha256(JSON.stringify(newIds)) });
        paths.push("kind=spec");
      }
    }
  }
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
  const before = new Map(fingerprintList(join(work, "input/local")).map((f) => [`local/${f.path}`, `${f.kind}:${f.sha256}`]));
  const after = new Map(fingerprintList(dir).map((f) => [`local/${f.path}`, `${f.kind}:${f.sha256}`]));
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .filter((p) => before.get(p) !== after.get(p))
    .map((path) => ({ path, detail: `固定時 ${before.get(path) ?? "無い"}、今 ${after.get(path) ?? "無い"}` }));
  if (head !== prep.head) changed.unshift({ path: "土台の HEAD", detail: `固定時 ${prep.head}、今 ${head || "取れない"}` });
  return { at, dir, head, changed };
}

// 保存直前の再照合で見つかった変化を確認が残る事項にする
function recheckRemaining(prefix: string, requirements: RequirementsRecheck | null, local: LocalRecheck | null): Remaining[] {
  return [
    ...(local?.changed ?? []).map((c) => ({ ref: c.path, owner: "人", reason: `${prefix}: 未コミット変更の土台 HEAD・差分の変化（固定した変更と現在の変更が異なる。${c.detail}）`, from: prefix })),
    ...(requirements?.changed ?? []).map((c) => ({ ref: c.path, owner: "人", reason: `${prefix}: 保存時の要求の変化（現在の要求への適合を確かめていない。固定時 ${c.before ?? "無い"}、取り直し ${c.after ?? "無い"}）`, from: prefix })),
  ];
}

// 基点の指定を GitHub のブランチ名にする（ローカルのブランチ名、または remote 名を外した追跡ブランチ名）。これがレビューした基点で、解決できなければ null
function baseBranch(prep: Prepared): string | null {
  const ref = git(prep.repo, "rev-parse", "--symbolic-full-name", prep.base).stdout.toString().trim();
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  return /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref)?.[1] ?? null;
}

// 現在の head と基点の照合（parent/head-check.md に書き足す）
interface HeadCheck {
  label: string;
  at: string;
  command: string;
  currentHead: string | null;
  currentBase: string | null;
  // レビューした基点（基点の指定 baseSpec をブランチ名に解決したもの）。null なら現在の基点と照合できない
  reviewedBase: string | null;
  baseSpec: string;
  headOk: boolean;
  baseOk: boolean;
  problem: string | null;
}

// 10節の8・11節: head を固定した元（PR は gh pr view の headRefOid と baseRefName、ref は git rev-parse と基点の指定）から取り直し、固定した head とレビューした基点に比べる
function takeHead(work: string, prep: Prepared, reviewedBase: string | null, label: string): HeadCheck {
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
    currentBase = baseBranch(prep);
  } else problem = "現在の head を取り直せない（ref なし: head を SHA だけで固定した）";
  const check: HeadCheck = { label, at, command, currentHead, currentBase, reviewedBase, baseSpec: prep.base, headOk: currentHead === prep.head, baseOk: reviewedBase !== null && currentBase === reviewedBase, problem };
  const file = join(work, "parent/head-check.md");
  if (!existsSync(file)) writeFileSync(file, "# 現在の head と基点の照合\n\nhead を固定した元（parent/head-source.md）から取り直した現在の head と基点を、固定した head とレビューした基点（基点の指定をブランチ名に解決したもの）と比べた記録。\n\n");
  const lines = [
    `## ${label}（${at}）`,
    "",
    `- コマンド: \`${command}\``,
    `- 固定した head: \`${prep.head}\``,
    `- 現在の head: ${currentHead ? `\`${currentHead}\`（${check.headOk ? "一致" : "不一致"}）` : "取り直せない"}`,
    `- レビューした基点: ${reviewedBase ?? `なし（基点の指定 ${prep.base} をブランチ名に解決できない）`}`,
    `- 現在の基点: ${currentBase ?? "取り直せない"}（${check.baseOk ? "一致" : reviewedBase === null || currentBase === null ? "照合できない" : "不一致"}）`,
    `- 結果: ${problem ?? (check.headOk && check.baseOk ? "一致" : headProblems(check).join("・"))}`,
    "",
  ];
  writeFileSync(file, lines.join("\n"), { flag: "a" });
  return check;
}

// 現在の head と基点の照合で、マージ可否を不可にする理由。照合できないときは変わったと断定しない
function headProblems(h: HeadCheck): string[] {
  if (h.problem) return [h.problem];
  const base =
    h.reviewedBase === null
      ? `基点をブランチ名に解決できず、現在の基点と照合できない（基点の指定 ${h.baseSpec}）`
      : h.currentBase === null
        ? `現在の基点を取り直せず、レビューした基点 ${h.reviewedBase} と照合できない`
        : `基点が変わった（レビューした基点 ${h.reviewedBase}、現在の基点 ${h.currentBase}）`;
  return [...(h.headOk ? [] : [`対象版が現在の head と違う（追加コミット。現在の head ${h.currentHead}）`]), ...(h.baseOk ? [] : [base])];
}

interface MergeDecision {
  merge: string;
  blockers: string[];
}

// 10節の8: 最終状態が完了・確定した要対応0件（点数 5）・確認が残る事項0件・現在の head と基点がレビューした版と同じのときだけ可。CI の結果は見ない。
// mode: local は常に不可。評価用の事例は照合対象が無いので head を渡さず（null）、残りの条件だけで決める。
// 対応表の「未充足」と要対応、「未確認」と確認が残る事項の対応は check-refute の形式の検査で担保するので、対応表の行はここで見ない
function decideMerge(m: { status: Status; reason: string | null; score: number | null; remaining: number; local: boolean; head: HeadCheck | null }): MergeDecision {
  const blockers = [
    ...(m.status === "完了" ? [] : [`最終状態 ${m.status}（理由: ${m.reason}）`]),
    ...(m.score === 5 ? [] : [m.score === null ? "点数なし" : `確定した要対応の点数 ${m.score}`]),
    ...(m.remaining > 0 ? [`確認が残る事項 ${m.remaining} 件`] : []),
    ...(m.local ? [LOCAL_MERGE] : []),
    ...(m.head ? headProblems(m.head) : []),
  ];
  return { merge: blockers.length === 0 ? MERGE_OK : NOT_RUN_MERGE, blockers };
}

// ---- 報告の組み立て（parent-details.md 11節。結果 report.md と監査 audit.md） ----

interface ReportContext {
  work: string;
  prep: Prepared;
  runId: string;
  mode: "issue" | "request" | "case";
  state: ReviewState;
  score: number | null;
  remaining: Remaining[];
  head: HeadCheck | null;
  decision: MergeDecision;
  labelPlan: string;
  requirements: RequirementsRecheck | null;
  local: LocalRecheck | null;
  // 報告に載せる計測（prepare の開始から報告の組み立ての直前まで）
  usage: ReportUsage;
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
  const { work, prep, state, decision } = c;
  const W = (rel: string) => `\`${join(work, rel)}\``;
  const agents = loadList<AgentRecord>(work, "agents");
  const retired = loadList<AttemptRecord>(work, "attempts");
  const checks = loadList<CheckRecord>(work, "checks");
  const identities = loadList<Identity>(work, "identity");
  const deps = prep.deps;
  const refute = state.refute;
  const required = refute?.required ?? [];
  const impacts = required.map((r) => `${r.heading}（${r.ids.join("・")}）: ${r.impact}`);
  const scoreCalc =
    c.score === null
      ? `${state.status}のため点数なし。`
      : `要対応 ${required.length} 件（${impacts.join("、") || "なし"}）。最も重い影響度（最小値）で ${c.score}${required.length === 0 ? "（要対応0件なので 5）" : ""}。`;
  const verdictFile = join(work, "refute/verdict.md");
  const verdictText = refute && existsSync(verdictFile) ? readFileSync(verdictFile, "utf8") : null;
  const embed = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);
  const manifestRows = new Map(
    [...(existsSync(join(work, "input/manifest.md")) ? readFileSync(join(work, "input/manifest.md"), "utf8") : "").matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \| (.*) \|$/gm)].map((m) => [m[1] ?? "", { sha: m[2] ?? "", source: m[3] ?? "" }]),
  );
  const roleRow = (role: Role) => {
    const r = ROLES[role];
    const list = agents.filter((a) => a.role === role);
    const last = list.at(-1);
    const check = last ? checks.filter((x) => x.role === role && x.attempt === last.attempt).at(-1) : undefined;
    const valid = role === "refute" ? !!refute : !!check?.valid && !retired.some((a) => a.role === role && a.attempt === last?.attempt);
    const outputPath = join(work, role, r.output);
    const end = !last ? "起動せず" : valid ? "有効な結果を受領" : "有効な結果なし";
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
    ["親の検査記録", "parent/checks.md"],
    ["反証への入力の指紋", "parent/fingerprints.md"],
    ["試行の記録", "parent/agents.md"],
    ["無効な試行の記録", "parent/attempts.md"],
    ["head を固定した元", "parent/head-source.md"],
    ["現在の head の照合", "parent/head-check.md"],
  ];
  const h = c.head;
  const headLine = h
    ? `- 現在の head と基点の照合: ${
        h.problem ??
        `現在の head ${h.currentHead}（${h.headOk ? "固定した head と一致" : "不一致。対象版が現在の head と違う（追加コミット）"}）、現在の基点 ${h.currentBase ?? "取り直せない"}（${
          h.baseOk
            ? `レビューした基点 ${h.reviewedBase} と一致`
            : h.reviewedBase === null
              ? `基点の指定 ${h.baseSpec} をブランチ名に解決できず照合できない`
              : h.currentBase === null
                ? `レビューした基点 ${h.reviewedBase} と照合できない`
                : `レビューした基点 ${h.reviewedBase} と不一致。基点が変わった`
        }）`
      }。取得: \`${h.command}\`（${h.at}）。記録: ${W("parent/head-check.md")}`
    : `- 現在の head と基点の照合: 照合せず（${state.status === "未実施" ? "未実施" : prep.caseDir ? "評価用の事例" : "mode: local"}）`;
  const followUp =
    state.status === "完了"
      ? `確定した要対応の点数 ${c.score}、要対応 ${required.length} 件、確認が残る事項 ${c.remaining.length} 件。${c.remaining.length > 0 ? "完了でも確認が残る事項は、提出・完了に必要な確認の不足として既存の提出・完了条件へ委ねる。" : ""}`
      : `独立レビュー${state.status}（${state.reason}）。試行の記録と受領済みの成果は上の担当と試行の記録の節。Done・In Review・PR へ進めない（委譲し直しや利用枠の回復待ちで代替しない）。`;
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
    `- 点数の計算: ${scoreCalc}未確認が残っていても完了なら計算し、軸間で平均せず、任意・棄却・基点から存在（対象外）・未確認は入れない。点数は確定した要対応の影響度だけを表し、要求の確認率もマージ許可も表さない。`,
    `- 確認が残る事項: ${c.remaining.length} 件（下の「確認が残る事項」の節）。最終状態と点数を変えず、マージ可否だけを止める。`,
    `- マージ可否: ${decision.merge}`,
    ...(decision.blockers.length > 0 ? [`  - 不可の理由: ${decision.blockers.join("／")}`] : []),
    "  - 可は、最終状態が完了・確定した要対応0件（点数 5）・確認が残る事項0件・現在の head と基点がレビューした版と同じ（次の照合）のときだけ。mode: local は対象外で常に不可。CI の結果は見ない（CI が落ちた PR のマージを止めるのは GitHub の必須ステータスチェック）。",
    "  - 「完了・確定した要対応の点数 5・確認が残る事項あり・マージ不可」は正常な結果である。可でもリポジトリの既存のマージ条件（ブランチ保護・必須のレビューなど）は省かない。",
    headLine,
    `- merge-ready: ${c.labelPlan}。報告の保存と作業ログの直後に行う操作として書く。ラベルは現在の判定の表示で、自動マージの指示ではない。操作の結果は、判定した head SHA・現在の head と基点の照合・レビューした基点・マージ可否・この報告の Document ID・runId とともに、本文が ${MERGE_READY_LOG} で始まる --kind progress の作業ログに記録する`,
    `- 対象版: 元のリポジトリ \`${prep.repo}\`／基点の指定 \`${prep.base}\`／merge-base \`${prep.mergeBase}\`／head \`${prep.head}\`／mode ${prep.mode}${prep.mode === "local" ? `（土台の HEAD \`${prep.head}\`、${prep.inputs.filter((i) => i.path.startsWith("local/")).map((i) => `\`${i.path}\` ${i.sha256}`).join("・")}）` : ""}${prep.caseDir ? `／評価用の事例 ${prep.case}` : ""}`,
    `- 担当用の限定 clone: ${W("repo")}（記録: ${W("parent/clone.md")}）。prepare の確認: ${prep.clone ? (prep.clone.checks.every((x) => x.ok) ? "すべて通った" : "通らない確認がある") : "作っていない"}。段階ごとの同一性の確認 ${identities.length} 回（不一致 ${identities.filter((i) => !i.ok).length} 回。記録: ${W("parent/identity.md")}）`,
    `- 依存の写し: ${
      deps?.prepared
        ? `${W("deps/")}、lockfile \`${deps.lockfile}\`（sha256 ${deps.lockfileSha256}）、${deps.manager} ${deps.version}、準備のコマンド \`${deps.command}\`（終了コード ${deps.exitCode}）、取得元 ${deps.registry}、指紋の一覧 \`input/deps-files.sha256\`（sha256 ${fileSha(join(work, "input/deps-files.sha256"))}、ファイル ${deps.files} 件・リンク ${deps.links} 件）`
        : `依存の写しなし（${deps?.reason ?? "準備していない"}）`
    }`,
    `- 未コミット変更の差分確認: ${c.local ? `${c.local.at} に土台の HEAD ${c.local.head} と差分を取り直した（${W("parent/local-recheck/")}）。${c.local.changed.length > 0 ? `変化あり: ${c.local.changed.map((x) => `${x.path}（${x.detail}）`).join("・")}（確認が残る事項に入れた）` : "変化なし"}` : "対象外（mode: commit）"}`,
    "",
    "### 確認が残る事項",
    "",
    "判定本文の未確認（コード要求の中身を決める要求資料の不足、結論に必要な依存の契約の不足、要求間の矛盾、採否を確定できない候補。どのコード上の結論に何が足りないかを理由と不足箇所に書く）、保存時の要求の変化、未コミット変更の土台 HEAD・差分の変化を、例外なくすべて載せる。",
    "",
    ...(c.remaining.length > 0 ? ["| 要求の出典（または候補 ID） | 確かめる担当 | 理由 |", "|---|---|---|", ...c.remaining.map((r) => `| ${cell(r.ref)} | ${cell(r.owner)} | ${cell(r.reason)} |`)] : ["なし"]),
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
    "### 担当",
    "",
    "| 役割 | 定義名 | 担当 ID（有効な結果の担当） | 試行 | 終了状態 | 引き渡しの検査 | モデル申告と出典 |",
    "|---|---|---|---|---|---|---|",
    ...(["standards", "spec", "refute"] as const).map(roleRow),
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
    `マージ可否は${decision.merge}。${decision.merge === MERGE_OK ? "" : "人の判断なしにマージへ進めない。"}`,
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
  ].join("\n");
}

// 利用者向けの結果に載せる範囲の注記（固定の1文。CI・E2E・QA で担保したとは書かない）
const SCOPE_NOTE = "このレビューはコードレベルの確認であり、ブラウザ検証・見た目やデザイン・実環境での動作・作業手順は確かめておらず、別のフローで扱う。";

function renderReport(c: ReportContext, auditRef: string): string {
  const required = c.state.refute?.required ?? [];
  return [
    "## 結果",
    "",
    `- 最終状態: ${statusLine(c)}`,
    `- 確定した要対応の点数: ${c.score ?? NOT_RUN_SCORE}`,
    `- 確認が残る事項: ${c.remaining.length} 件`,
    `- 対象: ${c.prep.head}（基点 ${c.prep.base}、merge-base ${c.prep.mergeBase}、mode ${c.prep.mode}）`,
    `- 範囲: ${SCOPE_NOTE}`,
    `- マージ可否: ${c.decision.merge}`,
    ...(c.decision.blockers.length > 0 ? [`- 理由: ${c.decision.blockers.join("／")}`] : []),
    `- merge-ready: ${c.labelPlan}。実際の操作結果は保存後の ${MERGE_READY_LOG} で始まる作業ログを参照`,
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
    "全対応表・担当別の原文・指紋・取得と再照合・担当と試行の記録は監査記録にある。",
    "",
  ].join("\n");
}

// ---- 保存・作業ログ・merge-ready（parent-details.md 11節） ----

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

// 監査の印の間（反証の判定本文）の指紋を、検査した原本の指紋と比べる
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

// parent-details.md 11節: 作業ログを nod の上限に決定的に収める。文字列の部分（必須の項目）はそのまま残し、一覧は1件ずつ順に（どれも先頭から）
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

// 作業ログを1件書き、返った id を返す。書けなければ終了コードと nod のエラー文を返す
function writeWorkLog(issue: string, text: string, kind: "progress" | "blocker"): { id: number | null; problem: string | null } {
  const p = nod(["--json", "issue", "log", issue, text, "--kind", kind]);
  const id = (parseJson(p) as { id?: unknown } | undefined)?.id;
  if (typeof id !== "number") return { id: null, problem: failure(p) };
  return { id, problem: null };
}

// 11節: 報告の保存と作業ログの後に merge-ready を付け外しし、本文が [merge-ready] で始まる --kind progress の作業ログに1件残す。
// 可なら付ける直前に現在の head と基点を取り直し、違う・取り直せない・保存に失敗したときは付けない（付いていれば外す）
// 不可の理由 blockers が上限に収まらなければ、書けなかった件数と全文の場所 more を書く
function applyMergeReady(
  work: string,
  prep: Prepared,
  issue: string,
  x: { merge: string; blockers: string[]; reviewedBase: string | null; head: HeadCheck | null; reportId: number | null; runId: string; saveProblem: string | null; more: string },
): LabelResult {
  const labels = issueLabels(issue);
  const labeled = labels?.includes("merge-ready") ?? false;
  const blockers = [...x.blockers];
  let head = x.head;
  if (x.merge === MERGE_OK) {
    if (x.saveProblem) blockers.push(x.saveProblem);
    else {
      head = takeHead(work, prep, x.reviewedBase, "merge-ready を付ける直前");
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
  const text = fitWorkLog([
    `${MERGE_READY_LOG} merge-ready: ${operation}`,
    logList("（マージ可否が不可: ", blockers, "）", x.more),
    "。",
    `判定した head SHA ${prep.head}${head?.currentHead ? `、現在の head ${head.currentHead}（${head.headOk ? "一致" : "不一致"}）` : head?.problem ? `、${head.problem}` : "、現在の head と基点は照合せず"}、`,
    `レビューした基点 ${x.reviewedBase ?? "なし（ブランチ名に解決できない）"}（基点の指定 ${prep.base}、merge-base ${prep.mergeBase}）`,
    head ? `、現在の基点 ${head.currentBase ?? "取り直せない"}（${head.baseOk ? "一致" : head.reviewedBase === null || head.currentBase === null ? "照合できない" : "不一致"}）、` : "、",
    `マージ可否 ${blockers.length === 0 ? MERGE_OK : NOT_RUN_MERGE}、`,
    `報告Document ${x.reportId ?? "保存できず"}、runId ${x.runId}。`,
    "ラベルは現在の判定の表示で、自動マージの指示ではない。",
    ...(error ? [`ラベルの操作の問題: ${error}。`] : []),
  ]);
  const log = writeWorkLog(issue, text, "progress");
  const logError = log.problem ? `${MERGE_READY_LOG} の作業ログを書けない（${log.problem}）` : null;
  return { operation, blockers, head, error: [error, logError].filter((e) => e !== null).join("。") || null, log: log.id };
}

// 11節の作業ログ（完了は progress、未実施・未完了は blocker）の本文。マージ可否・merge-ready は書かず [merge-ready] の記録を参照する。
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
  const mergeNote = `マージ可否・merge-ready は ${MERGE_READY_LOG} で始まる作業ログを参照`;
  if (c.state.status === "完了") {
    const required = c.state.refute?.required ?? [];
    return fitWorkLog([
      `独立コードレビュー完了。確定した要対応の点数 ${c.score}。`,
      logList("要対応: ", required.map((r) => `${r.heading}（${severityOf(r.impact)}: ${r.title}）`), "。", more, "要対応: なし。"),
      `確認が残る事項 ${c.remaining.length} 件`,
      logList("（", c.remaining.map((r) => `${r.ref}（${r.owner}、${r.reason}）`), "）", more),
      "。",
      ...docs,
      `。runId ${c.runId}。担当: ${ids}。`,
      retries,
      `${mergeNote}。`,
      finalUsageText(final, c.work),
    ]);
  }
  return fitWorkLog([
    `独立コードレビュー${c.state.status}。原因: ${c.state.reason}。`,
    `試行: ${ids}。`,
    retries,
    `受領済みの成果: ${agents.filter((a) => a.receivedAt).map((a) => `${a.roleName}の試行 ${a.attempt}`).join("、") || "なし"}。点数なし。`,
    ...docs,
    `。runId ${c.runId}。Done・In Review・PR へ進めない。${mergeNote}。`,
    finalUsageText(final, c.work),
  ]);
}

// ---- finalize（parent.md・parent-details.md 10節・11節） ----

function finalize(args: string[]): Outcome {
  const o = parseOptions(args, ["work", "not-run-reason", "session", "skill-start"], []);
  const work = absolute("work", o.one.get("work"));
  if (!work) throw new UsageError("--work <W の絶対パス> が要ります");
  const prep = prepareRecord(work);
  if (existsSync(join(work, "parent/finalize.json"))) throw new UsageError("finalize は実行済みです（報告を保存し直さない）");
  const session = parentSession(absolute("session", o.one.get("session")));
  const skillStartArg = o.one.get("skill-start");
  if (skillStartArg !== undefined && Number.isNaN(Date.parse(skillStartArg))) throw new UsageError(`--skill-start は ISO 8601 の時刻にしてください: ${skillStartArg}`);
  const runId = basename(work);
  const mode: ReportContext["mode"] = prep.caseDir ? "case" : prep.issue ? "issue" : "request";
  const state = reviewStatus(work, prep, o.one.get("not-run-reason"));
  const score = state.status === "完了" && state.refute ? Math.min(5, ...state.refute.required.flatMap((r) => (r.impact === null ? [] : [r.impact]))) : null;

  // 10節の1・2: 保存直前の再照合（未コミット変更・要求資料）
  const ready = prep.ready;
  const local = ready && prep.mode === "local" ? recheckLocal(work, prep, join(work, "parent/local-recheck")) : null;
  const requirements = ready ? recheckRequirements(work, prep, join(work, "parent/requirements-recheck")) : null;
  const remaining = [...verdictRemaining(state.refute), ...recheckRemaining("保存直前の再照合", requirements, local)];

  // 10節の8: 現在の head と基点を取り直してレビューした版と比べ、マージ可否を決める（CI は照合しない）
  const reviewedBase = baseBranch(prep);
  const head = state.status !== "未実施" && prep.mode === "commit" && !prep.caseDir ? takeHead(work, prep, reviewedBase, "マージ可否を決める直前") : null;
  const decision = decideMerge({ status: state.status, reason: state.reason, score, remaining: remaining.length, local: prep.mode === "local", head });
  const labeled = mode === "issue" && prep.issue ? (issueLabels(prep.issue)?.includes("merge-ready") ?? false) : false;
  const labelPlan =
    mode === "case" ? "扱わない（評価用の事例）" : mode === "request" ? "扱わない（Issue なし）" : decision.merge === MERGE_OK ? "付ける予定（付ける直前に現在の head と基点を取り直す）" : labeled ? "外す予定" : "付けない";

  // 報告の組み立て・保存の直前。報告に載せる区間の値（計測の1つ目）はこの時刻までを数える
  const reportStartedAt = now();
  const usage = reportUsage(work, prep, session, reportStartedAt);
  const ctx: ReportContext = { work, prep, runId, mode, state, score, remaining, head, decision, labelPlan, requirements, local, usage };
  const audit = renderAudit(ctx);
  writeFileSync(join(work, "parent/audit.md"), audit);
  const markers = [{ name: "refute-verdict", sha256: state.refute?.sha256 ?? null }];
  const problems = markerProblems(audit, markers, "監査の原稿 parent/audit.md");
  let documents: { audit: SavedDocument; report: SavedDocument } | null = null;
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
    const log = writeWorkLog(prep.issue, summaryLog(ctx, documents?.report.id ?? null, documents?.audit.id ?? null, problems, measured.final), kind);
    summaryLogId = log.id;
    if (log.problem) logProblem = `要約の作業ログを書けない（${log.problem}）`;
    label = applyMergeReady(work, prep, prep.issue, {
      merge: decision.merge,
      blockers: decision.blockers,
      reviewedBase,
      head,
      reportId: documents?.report.id ?? null,
      runId,
      saveProblem: saved ? null : `報告の保存・照合に失敗（${problems.join("、")}）`,
      more: `finalize の記録（${join(work, "parent/finalize.json")} の blockers）`,
    });
  }
  // 保存・照合の失敗や付ける直前の head・基点の変化で付けなかったときは、マージ可否を不可として扱う（報告 Document は書き換えない）
  const blockers = label ? label.blockers : saved ? decision.blockers : [...decision.blockers, `報告の照合に失敗（${problems.join("、")}）`];
  const record: Json = {
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
    head,
    recheck: {
      requirements: requirements && { at: requirements.at, changed: requirements.changed, unavailable: requirements.unavailable },
      local: local && { at: local.at, changed: local.changed },
    },
    report: join(work, "parent/report.md"),
    audit: join(work, "parent/audit.md"),
    reportSha256: sha256(report),
    auditSha256: sha256(audit),
    documents,
    saved,
    saveProblems: problems,
    logs: { summary: summaryLogId, mergeReady: label?.log ?? null },
    label: label ? { operation: label.operation, error: label.error } : { operation: labelPlan, error: null },
    logProblem,
    reportStartedAt,
    savedAt,
    usage: {
      record: join(work, "parent/usage.json"),
      report: { from: usage.from, to: usage.to, seconds: usage.seconds, parentTotalTokens: usage.parent.tally?.totalTokens ?? null },
      final: { from: measured.final.from, to: measured.final.to, seconds: measured.final.seconds, parentTotalTokens: measured.final.parent.tally?.totalTokens ?? null },
      comparison: { from: measured.comparison.from, to: measured.comparison.to, seconds: measured.comparison.seconds, parentTotalTokens: measured.comparison.parent.tally?.totalTokens ?? null },
    },
  };
  return { work, result: record };
}

// ---- 区間の時間と使用量（parent-details.md 14節。段階・委譲の時刻と omp のセッション記録から集計する） ----

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
  // 読み取り量と生成量: 応答のツール呼び出しと出力の内訳、ツール結果、ツール以外で文脈に入った記録（user などの message と custom_message）
  calls: RecordCall[];
  output: RecordOutput | null;
  result: RecordResult | null;
  context: { kind: string; size: ContentSize } | null;
}

// 記録に残った content の大きさ（text ブロックの UTF-8 のバイト数）と、大きさを数えない text 以外のブロックの数
interface ContentSize {
  bytes: number;
  nonText: number;
}

interface RecordCall {
  id: string | null;
  name: string;
  argumentBytes: number;
  // 記録の中に toolCallId の一致する結果がある
  answered: boolean;
}

interface RecordOutput {
  text: number;
  thinking: number;
  thinkingBlocks: number;
  unreadable: number;
  summarized: number;
  other: number;
}

interface RecordResult {
  callId: string | null;
  name: string;
  size: ContentSize;
  error: boolean;
  pruned: boolean;
  // 記録の中に対応する呼び出しがある。at は振り分けの時刻（呼び出しの応答の時刻。対応する呼び出しが無ければ結果自身の時刻）
  matched: boolean;
  at: number;
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

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

function contentSize(content: unknown): ContentSize {
  if (typeof content === "string") return { bytes: utf8(content), nonText: 0 };
  const size = { bytes: 0, nonText: 0 };
  for (const c of Array.isArray(content) ? (content as Json[]) : []) {
    if (c?.type === "text" && typeof c.text === "string") size.bytes += utf8(c.text);
    else size.nonText++;
  }
  return size;
}

// 応答の content の内訳。読める本文の無い thinking（本文が空、暗号化・redacted の種類）は unreadable に数える
function outputOf(content: Json[]): RecordOutput {
  const o: RecordOutput = { text: 0, thinking: 0, thinkingBlocks: 0, unreadable: 0, summarized: 0, other: 0 };
  for (const c of content) {
    const type = typeof c?.type === "string" ? c.type : "";
    if (type === "text" && typeof c.text === "string") o.text += utf8(c.text);
    else if (/thinking/i.test(type)) {
      o.thinkingBlocks++;
      if (c.summary === true) o.summarized++;
      if (type === "thinking" && typeof c.thinking === "string" && c.thinking !== "") o.thinking += utf8(c.thinking);
      else o.unreadable++;
    } else if (type !== "toolCall") o.other++;
  }
  return o;
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
    const role = j.type === "message" && typeof m?.role === "string" ? m.role : null;
    const content = Array.isArray(m?.content) ? (m.content as Json[]) : [];
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
      calls:
        role === "assistant"
          ? content
              .filter((c) => c?.type === "toolCall")
              .map((c) => ({ id: typeof c.id === "string" ? c.id : null, name: typeof c.name === "string" ? c.name : "不明", argumentBytes: utf8(JSON.stringify(c.arguments) ?? ""), answered: false }))
          : [],
      output: role === "assistant" ? outputOf(content) : null,
      result:
        role === "toolResult"
          ? { callId: typeof m?.toolCallId === "string" ? m.toolCallId : null, name: typeof m?.toolName === "string" ? m.toolName : "不明", size: contentSize(m?.content), error: m?.isError === true, pruned: m?.prunedAt !== undefined && m?.prunedAt !== null, matched: false, at }
          : null,
      context:
        j.type === "custom_message"
          ? { kind: `custom_message:${String(j.customType)}`, size: contentSize(j.content) }
          : role !== null && role !== "assistant" && role !== "toolResult"
            ? { kind: role, size: contentSize(m?.content) }
            : null,
    });
  }
  // ツール結果は toolCallId で呼び出しに結び付け、呼び出した応答の時刻で振り分ける（呼び出しと結果を別の範囲に割らない）
  const calls = new Map(records.flatMap((r) => r.calls.map((c) => [c.id, { at: r.at, call: c }] as const)));
  for (const r of records) {
    const hit = r.result?.callId ? calls.get(r.result.callId) : undefined;
    if (!r.result || !hit) continue;
    r.result.matched = true;
    r.result.at = hit.at;
    hit.call.answered = true;
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
  io: Io;
}

// 範囲の読み取り量と生成量（大きさは記録に残った UTF-8 のバイト数。課金される token 数とは別）
export interface Io {
  tools: ToolIo[];
  generated: Generated;
  context: ContextIo[];
}

export interface ToolIo {
  name: string;
  calls: number;
  argumentBytes: number;
  results: number;
  // 記録に残った結果の text ブロックの合計。刈り込み済みの結果は置き換え後の大きさ、text 以外のブロックは入らない
  resultBytes: number;
  errors: number;
  pruned: number;
  nonTextBlocks: number;
  orphanResults: number;
  callsWithoutResult: number;
}

export interface Generated {
  responses: number;
  textBytes: number;
  thinkingBlocks: number;
  // 読める本文の無い thinking があれば null（取得できず）
  thinkingBytes: number | null;
  unreadableThinking: number;
  summarizedThinking: number;
  toolCalls: number;
  toolCallArgumentBytes: number;
  otherBlocks: number;
}

export interface ContextIo {
  kind: string;
  records: number;
  bytes: number;
  nonTextBlocks: number;
}

function ioOf(records: SessionRecord[], inside: (at: number) => boolean): Io {
  const tools = new Map<string, ToolIo>();
  const tool = (name: string) => {
    const t = tools.get(name) ?? { name, calls: 0, argumentBytes: 0, results: 0, resultBytes: 0, errors: 0, pruned: 0, nonTextBlocks: 0, orphanResults: 0, callsWithoutResult: 0 };
    tools.set(name, t);
    return t;
  };
  const responses = records.filter((r) => isResponse(r) && inside(r.at));
  const g: Generated = { responses: responses.length, textBytes: 0, thinkingBlocks: 0, thinkingBytes: 0, unreadableThinking: 0, summarizedThinking: 0, toolCalls: 0, toolCallArgumentBytes: 0, otherBlocks: 0 };
  let thinking = 0;
  for (const r of responses) {
    for (const c of r.calls) {
      const t = tool(c.name);
      t.calls++;
      t.argumentBytes += c.argumentBytes;
      if (!c.answered) t.callsWithoutResult++;
      g.toolCalls++;
      g.toolCallArgumentBytes += c.argumentBytes;
    }
    const o = r.output;
    if (!o) continue;
    g.textBytes += o.text;
    g.thinkingBlocks += o.thinkingBlocks;
    thinking += o.thinking;
    g.unreadableThinking += o.unreadable;
    g.summarizedThinking += o.summarized;
    g.otherBlocks += o.other;
  }
  g.thinkingBytes = g.unreadableThinking > 0 ? null : thinking;
  const context = new Map<string, ContextIo>();
  for (const r of records) {
    const x = r.result;
    if (x && inside(x.at)) {
      const t = tool(x.name);
      t.results++;
      t.resultBytes += x.size.bytes;
      t.nonTextBlocks += x.size.nonText;
      if (x.error) t.errors++;
      if (x.pruned) t.pruned++;
      if (!x.matched) t.orphanResults++;
    }
    if (r.context && inside(r.at)) {
      const c = context.get(r.context.kind) ?? { kind: r.context.kind, records: 0, bytes: 0, nonTextBlocks: 0 };
      c.records++;
      c.bytes += r.context.size.bytes;
      c.nonTextBlocks += r.context.size.nonText;
      context.set(c.kind, c);
    }
  }
  const byName = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return { tools: [...tools.values()].sort(byName((t) => t.name)), generated: g, context: [...context.values()].sort(byName((c) => c.kind)) };
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
    io: ioOf(records, (at) => at >= from && at < to),
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
    "区間は委譲の時刻で分ける。担当の区間は段階（探索・反証）ごとの最初の委譲の開始から最後の最終返答の受領まで（並列の探索は2担当の時間を合算しない）、その前後と間を親の区間とする",
  missing: "取得できない値は 0 にせず「取得できず」（JSON では null）と理由を書く",
  io:
    "読み取り量と生成量は、使用量と同じ範囲と応答単位で数えた記録の大きさ（UTF-8 のバイト数）で、課金される token 数と同じではない（各応答の使用量にはその時点までの文脈全体が入る）。ツールの呼び出しと引数（arguments の JSON）の大きさは呼び出しを含む応答の時刻で振り分け、ツール結果は toolCallId で呼び出しに結び付けて呼び出しの応答と同じ範囲に入れる。対応する呼び出しが記録に無い結果は結果自身の時刻で振り分け、別に数える。結果の大きさは記録に残った text ブロックの合計で、刈り込み済み（prunedAt あり）の結果は置き換え後の大きさしか残らず元の大きさは取得できず、text 以外のブロックは件数だけ数えて大きさは取得できず。出力の内訳は応答の content の本文（text）、thinking、ツール呼び出しの引数の大きさで、出力 token（output）とは別の値。読める本文の無い thinking（本文が空、暗号化・redacted など）があれば thinking の大きさは取得できず、要約（summary）の thinking は要約の大きさ。ツール以外で文脈に入った記録（user などの message と custom_message）は自身の時刻で振り分け、種類（custom_message は customType）ごとに件数と大きさを数える",
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

function parentSession(arg: string | undefined, option = "finalize の --session"): ParentSession {
  if (arg) return { path: arg, origin: option, missing: "" };
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
];
// 親の区間の名前（前の担当の段階-次の担当の段階）
const PARENT_SECTIONS: Record<string, string> = {
  "-explore": "準備",
  "explore-refute": "引き渡しの検査",
  "-": "準備と仕上げ",
  "explore-": "引き渡しの検査と仕上げ",
  "refute-": "反証の検査と仕上げ",
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

// 通常の skill://nod/code-review、接頭辞なし/コロン接頭辞のURI、または code-review/SKILL.md の実パス
const SKILL_LOAD = /^skill:\/\/(?:[^/\s]+[/:])?code-review\/?$|(?:^|\/)code-review\/SKILL\.md$/;

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
    "## 4. 読み取り量と生成量（区間・役割・試行ごと）",
    "",
    ...ioBody([
      ...report.sections.map((s) => ({ label: `1 の区間「${s.name}」の親`, m: s.parent })),
      ...report.attempts.map((a) => ({ label: `1 の試行: ${a.roleName} ${a.attempt}（${a.agentId ?? "担当 ID 不明"}）`, m: a })),
      { label: "3 の前後比較用の親", m: comparison.parent },
    ]),
    "",
    "## 段階",
    "",
    "| サブコマンド | 開始 | 終了 |",
    "|---|---|---|",
    ...report.stages.map((s) => `| ${s.subcommand} | ${s.startedAt} | ${s.endedAt ?? "実行中（この計測の後に終わる）"} |`),
    "",
  ].join("\n");
}

// 読み取り量と生成量の表（usage.md だけに書き、結果・監査 Document には書かない）
function ioBody(rows: { label: string; m: Measured }[]): string[] {
  const absent = (label: string, m: Measured, columns: number) => `| ${cell(label)} | ${cell(`取得できず（${m.unavailable}）`)} |${" 取得できず |".repeat(columns - 2)}`;
  const resultSize = (t: ToolIo) => {
    const notes = [
      ...(t.pruned > 0 ? [`刈り込み済み ${t.pruned} 件は置き換え後の大きさで、元の大きさは取得できず`] : []),
      ...(t.nonTextBlocks > 0 ? [`text 以外のブロック ${t.nonTextBlocks} 件の大きさは取得できず`] : []),
    ];
    return `${t.resultBytes}${notes.length > 0 ? `（${notes.join("。")}）` : ""}`;
  };
  const thinkingText = (g: Generated) =>
    g.thinkingBytes === null
      ? `取得できず（読める本文の無い thinking ${g.unreadableThinking} 件。全 ${g.thinkingBlocks} 件）`
      : `${g.thinkingBytes}（${g.thinkingBlocks} 件${g.summarizedThinking > 0 ? `。うち要約 ${g.summarizedThinking} 件は要約の大きさ` : ""}）`;
  return [
    `- 定義: ${USAGE_DEFINITIONS.io}`,
    "",
    "### ツールの種類ごと",
    "",
    "| 範囲 | ツール | 呼び出し | 引数（バイト） | 結果 | 記録に残った結果の大きさ（バイト） | エラーの結果 | 対応する呼び出しの無い結果 | 結果の記録の無い呼び出し |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.flatMap(({ label, m }) => {
      const io = m.tally?.io;
      if (!io) return [absent(label, m, 9)];
      if (io.tools.length === 0) return [`| ${cell(label)} | なし | 0 | 0 | 0 | 0 | 0 | 0 | 0 |`];
      return io.tools.map((t) => `| ${cell(label)} | ${cell(t.name)} | ${t.calls} | ${t.argumentBytes} | ${t.results} | ${resultSize(t)} | ${t.errors} | ${t.orphanResults} | ${t.callsWithoutResult} |`);
    }),
    "",
    "### 出力の内訳",
    "",
    "| 範囲 | 応答 | 出力 token | 本文（バイト） | thinking（バイト） | ツール呼び出し（件数、引数のバイト） | その他のブロック |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(({ label, m }) => {
      const t = m.tally;
      if (!t) return absent(label, m, 7);
      const g = t.io.generated;
      return `| ${cell(label)} | ${g.responses} | ${tokens(t.output)} | ${g.textBytes} | ${thinkingText(g)} | ${g.toolCalls} 件、${g.toolCallArgumentBytes} | ${g.otherBlocks}${g.otherBlocks > 0 ? "（大きさは取得できず）" : ""} |`;
    }),
    "",
    "### ツール以外で文脈に入った記録",
    "",
    "| 範囲 | 種類 | 件数 | 大きさ（バイト） |",
    "|---|---|---|---|",
    ...rows.flatMap(({ label, m }) => {
      const io = m.tally?.io;
      if (!io) return [absent(label, m, 4)];
      if (io.context.length === 0) return [`| ${cell(label)} | なし | 0 | 0 |`];
      return io.context.map((c) => `| ${cell(label)} | ${cell(c.kind)} | ${c.records} | ${c.bytes}${c.nonTextBlocks > 0 ? `（text 以外のブロック ${c.nonTextBlocks} 件の大きさは取得できず）` : ""} |`);
    }),
  ];
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
      "## 読み取り量と生成量",
      "",
      ...ioBody([{ label: "親", m: parent }, ...agents.map((x) => ({ label: `担当 ${x.agentId}`, m: x }))]),
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
  "check-boundary": checkBoundary,
  finalize,
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
