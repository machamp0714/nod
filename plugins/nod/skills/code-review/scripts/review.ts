#!/usr/bin/env bun
// nod:code-review の親の定型作業を、段階の境目ごとのサブコマンドで行う（parent.md）。モデルを起動せず、テスト・Lint・ビルドを実行しない。
// 使い方: bun review.ts <subcommand> --work <作業ディレクトリ W の絶対パス> ...
//   prepare（parent.md 1〜2節）: 対象の固定、秘密候補・空差分の検査、担当用の限定 clone と確認、依存の写しと指紋、共通入力と目録、head を固定した元。
//     --repo <絶対パス> --base <基点の指定> (--mode commit --head <SHA か ref> [--pr <URL>] | --mode local [--untracked <相対パス>]...)
//     [--issue <ID> | --request <絶対パス>... | --request-doc <Document ID>...] [--work <W（存在しないか空）> | --work-root <絶対パス>]
//     評価用の事例: --case <常設データセットの inputs/<case-id> の絶対パス> [--repo <絶対パス>]（nod を使わず case.md と requirements/ から作る）
//     W の既定は $HOME/.local/share/nod/code-reviews/<小文字の uuid>。後の段階は cloneChecks・depsFingerprint・inputFingerprint で同一性を確かめ直す
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

// parent.md の `find . -type f [! -path ./<exclude>] -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256` と同じ一覧
export function fileFingerprint(dir: string, exclude?: string): string {
  return walkEntries(dir)
    .filter((e) => e.kind === "file" && e.rel !== `./${exclude}`)
    .map((e) => `${sha256(readFileSync(e.path))}  ${e.rel}\n`)
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
export function inputFingerprint(work: string): { path: string; sha256: string }[] {
  return fileFingerprint(join(work, "input"), "manifest.md")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", rel = ""] = line.split(/ {2}\.\//);
      return { path: rel, sha256: hash };
    });
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

// ---- 振り分け（サブコマンドはここだけで登録する） ----

const SUBCOMMANDS: Record<string, (args: string[]) => Outcome> = { prepare };

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
