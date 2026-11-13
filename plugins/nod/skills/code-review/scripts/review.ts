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
// 外部コマンドとして curl（https の URL の GET）と、同じディレクトリの copy-evidence.ts（通常のファイル）も起動する。
// 結果: 標準出力に JSON を1行出し、同じものを <W>/parent/<subcommand>.json に書く。
// 終了コード 0 = 実行して結果を書いた（未実施などの否定の結果でも 0）、2 = 引数の誤り（code INVALID_INPUT。判定ではない）、それ以外 = 予期しない失敗
// 外部コマンド: nod は NOD_CLI（無ければ nod）、git・tar とパッケージ管理（bun・npm・pnpm・yarn・node）は PATH から起動する。
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
  work: string;
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

function exec(cmd: string[], opts: { cwd?: string } = {}): Proc {
  const [file, ...args] = cmd;
  const p = spawnSync(file ?? "", args, { cwd: opts.cwd, maxBuffer: 1 << 30 });
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

function nod(args: string[]): Proc {
  return exec([process.env.NOD_CLI || "nod", ...args]);
}

const failure = (p: Proc) => `終了コード ${p.code ?? "なし"}: ${(p.error ?? p.stderr).trim().split("\n").slice(-3).join(" ") || "出力なし"}`;

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

function issueRequirements(work: string, repo: string, id: string): Requirements {
  const dir = join(work, "input/requirements");
  const req: Requirements = { sources: new Map(), unavailable: [], issueLine: id, planLine: "計画の出典なし" };
  const at = now();
  const p = nod(["--json", "issue", "show", id]);
  writeFileSync(join(work, "parent/issue-snapshot.json"), p.stdout);
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

function requestRequirements(work: string, repo: string, requests: { key: string; value: string }[]): Requirements {
  const dir = join(work, "input/requirements");
  const req: Requirements = { sources: new Map(), unavailable: [], issueLine: "なし", planLine: "Issue なし" };
  requests.forEach((r, i) => {
    const name = `requirements/request-${i + 1}.md`;
    if (r.key === "request") {
      writeFileSync(join(work, "input", name), readFileSync(r.value));
      req.sources.set(name, `利用者が明示した要求のファイル（${r.value}、${now()}）`);
    } else {
      const doc = docContent(r.value);
      if (typeof doc === "string") req.unavailable.push({ item: `利用者が明示した要求の Document ${r.value}`, reason: doc });
      else {
        writeFileSync(join(work, "input", name), doc.content);
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

// 事例の requirements/（と standards/ の中身）を input/requirements/ へ写し、写した sha256 を事例の manifest.md と比べる。食い違いを返す
function caseRequirements(work: string, c: Case): { req: Requirements; mismatches: string[] } {
  const req: Requirements = { sources: new Map(), unavailable: c.unavailable.map((reason) => ({ item: "事例の manifest.md の記載", reason })), issueLine: "", planLine: "" };
  const mismatches: string[] = [];
  const caseSha = sha256(readFileSync(join(c.dir, "case.md")));
  if (c.hashes.get("case.md") !== caseSha) mismatches.push(`case.md（manifest.md: ${c.hashes.get("case.md") ?? "記載なし"}、実物: ${caseSha}）`);
  const copied = new Set<string>();
  for (const sub of ["requirements", "standards"]) {
    for (const e of walkEntries(join(c.dir, sub))) {
      const rel = `${sub}/${e.rel.slice(2)}`;
      const dest = join(work, "input/requirements", e.rel.slice(2));
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
    const c = caseRequirements(work, kase);
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
  if (!req) req = issue ? issueRequirements(work, repo, issue) : requestRequirements(work, repo, requests);
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
  repo: string;
  head: string;
  mergeBase: string;
  issue: string | null;
  case: string | null;
  caseDir?: string | null;
  clone: { checks: CloneCheck[] } | null;
  deps: { prepared: boolean } | null;
  inputs: FileHash[];
  manifestSha256: string | null;
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
const FORBIDDEN = ["重大度", "確信度", "要約", "推論", "総合判断", "原因の統合", "severity", "confidence", "summary"];
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

// 見出し・項目名・表の見出しに禁止項目の名前があるか（本文への混入は親が通読して確かめる）
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
    for (const n of names) if (FORBIDDEN.some((w) => n.toLowerCase().includes(w))) hits.push(`L${i + 1}「${plain(n)}」`);
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
function targetViolations(target: Section | undefined, names: readonly string[], role: Role, prep: Prepared, no: number, add: Add): void {
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
  if (state && !/完了|未確認/.test(state)) add(no, `終了状態が「完了」「未確認を含む」のどちらでもない（${state}）`);
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

// 要対応の節の1件（同一原因は1件。ids は含まれる候補 ID）
export interface RequiredItem {
  heading: string;
  title: string;
  ids: string[];
  impact: number | null;
  axis: Axis | null;
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
    required.push({ heading, title: plain(m?.[2] ?? ""), ids, impact: impact === undefined ? null : Number(impact), axis });
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
  resolvedAt?: string | null;
  replies?: ActivityItem[];
}

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
          const base = comment && typeof a.id === "number" ? `activity:${a.id}` : `activity@${a.at ?? "時刻なし"}`;
          const dup = (seen.get(base) ?? 0) + 1;
          seen.set(base, dup);
          const id = dup > 1 ? `${base}#${dup}` : base;
          const body = typeof a.body === "string" ? a.body : null;
          const ci = isCiActivity(a);
          const excluded = ci || removedWith !== null;
          const sha = sha256(body ?? JSON.stringify(a));
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
      const activitySha = sha256(readFileSync(join(A, "records/activity.json")));
      files.push({ path: "records/activity.json", sha256: activitySha, source: `Issue ${issue} の Activity（nod --json issue show、${takenAt}）から CI の結果を印で除いた写し` });
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

// ---- 振り分け（サブコマンドはここだけで登録する） ----

const SUBCOMMANDS: Record<string, (args: string[]) => Outcome> = {
  prepare,
  agent,
  "check-explore": checkExplore,
  "retire-attempt": retireAttempt,
  "refute-input": refuteInput,
  "check-refute": checkRefute,
  "acceptance-records": acceptanceRecords,
  "acceptance-input": acceptanceInput,
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
    const { work, result } = handler(args);
    const out = { ok: true, subcommand: sub, ...result };
    writeFileSync(join(work, "parent", `${sub}.json`), `${JSON.stringify(out, null, 2)}\n`);
    emit(out, 0);
  } catch (e) {
    if (e instanceof UsageError) emit({ ok: false, subcommand: sub, code: "INVALID_INPUT", message: e.message }, 2);
    emit({ ok: false, subcommand: sub, code: "UNEXPECTED_ERROR", message: e instanceof Error ? e.message : String(e) }, 1);
  }
}

if (import.meta.main) main(process.argv.slice(2));
