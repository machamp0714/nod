// code-review 同梱の review.ts をプロセスとして起動するテストの共通の準備（段階ごとのテストファイルで使う）
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, registerRepo, type RunResult, runNod, tempDir } from "./helpers";

export const SKILL_DIR = join(import.meta.dir, "../../../plugins/nod/skills/code-review");
export const REVIEW_SCRIPT = join(SKILL_DIR, "scripts/review.ts");
const NOD_MAIN = join(import.meta.dir, "../src/main.ts");

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export interface ReviewRun<T> {
  exitCode: number;
  // 標準出力の1行の JSON（読めなければ undefined）。形は段階ごとのテストが T で決める
  json: T | undefined;
  stdout: string;
  stderr: string;
}
// テスト1件分の一時領域。home は HOME、bin は PATH の先頭に足す偽コマンドの置き場、env は子プロセスへ渡す環境変数
export interface Sandbox {
  t: string;
  home: string;
  bin: string;
  env: Record<string, string>;
}

export function sandbox(): Sandbox {
  const t = tempDir("nod-review-");
  const home = join(t, "home");
  const bin = join(t, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const env: Record<string, string> = { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, NOD_ORCA: "0" };
  return { t, home, bin, env };
}

// review.ts <subcommand> ... を起動する。CLAUDECODE や omp の PI_SESSION_FILE などの外の環境に左右されないよう、テストの env で上書きする
export async function runReview<T>(sub: string, args: string[], s: Sandbox, extraEnv: Record<string, string> = {}): Promise<ReviewRun<T>> {
  return runReviewScript<T>(REVIEW_SCRIPT, sub, args, s, extraEnv);
}

// 別の場所に写した review.ts（同じディレクトリの ci-checks.ts などを差し替えたもの）を起動する
export async function runReviewScript<T>(script: string, sub: string, args: string[], s: Sandbox, extraEnv: Record<string, string> = {}): Promise<ReviewRun<T>> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDECODE: undefined, NOD_ACTOR: undefined, PI_SESSION_FILE: undefined, ...s.env, ...extraEnv };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const proc = Bun.spawn([process.execPath, script, sub, ...args], { cwd: s.t, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let json: T | undefined;
  try {
    json = JSON.parse(stdout) as T;
  } catch {
    json = undefined;
  }
  return { exitCode, json, stdout, stderr };
}

export function put(path: string, body: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

// 一時の Git リポジトリ（main に最初の commit）。名前は日本語を含められる
export function makeGitRepo(s: Sandbox, name = "app"): string {
  const repo = join(s.t, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  put(join(repo, "README.md"), "# app\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

// files を書いて commit し、その SHA を返す
export function commit(repo: string, files: Record<string, string>, message = "change"): string {
  for (const [path, body] of Object.entries(files)) put(join(repo, path), body);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return gitOut(repo, "rev-parse", "HEAD");
}

export function gitOut(cwd: string, ...args: string[]): string {
  const p = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (p.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${p.stderr}`);
  return p.stdout.trim();
}

// dir の配下のすべてのファイルとリンク（リンクは辿らない）の相対パス
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const walk = (p: string, rel: string) => {
    const st = lstatSync(p);
    if (st.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name), rel ? `${rel}/${name}` : name);
    else out.push(rel);
  };
  walk(dir, "");
  return out.sort();
}

// dir の配下のどこかのファイルに needle が含まれるか（リンクは辿らない）
export function anyFileContains(dir: string, needle: string): string[] {
  return filesUnder(dir).filter((rel) => {
    const p = join(dir, rel);
    return lstatSync(p).isFile() && readFileSync(p).includes(needle);
  });
}

// parent.md の指紋の取り方をそのままシェルで行う（スクリプトの実装とは独立の正解）
export function shellFingerprint(dir: string, opts: { exclude?: string; links?: boolean } = {}): string {
  const exclude = opts.exclude ? ` ! -path ./${opts.exclude}` : "";
  const files = `find . -type f${exclude} -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256`;
  const links = `find . -type l -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' l; do printf 'link %s -> %s\\n' "$l" "$(readlink "$l")"; done`;
  const p = spawnSync("bash", ["-c", opts.links ? `${files} && ${links}` : files], { cwd: dir, encoding: "utf8" });
  if (p.status !== 0) throw new Error(p.stderr);
  return p.stdout;
}

// 偽のパッケージ管理コマンド（bun・npm・pnpm・yarn・node）。ネットワークを使わず、引数と作業ディレクトリを log に残し、
// node_modules にファイルとリンクを作る。FAKE_PM_FAIL があれば準備の失敗（終了コード 7）を返す
export function fakePackageManager(s: Sandbox, name: string): { log: () => string[] } {
  const log = join(s.t, `${name}.log`);
  const path = join(s.bin, name);
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `printf '%s|%s\\n' "$(pwd)" "$*" >> "${log}"`,
      'for a in "$@"; do case "$a" in --version) echo 9.9.9-fake; exit 0;; config) echo https://registry.example.invalid/; exit 0;; esac; done',
      'if [ -n "$FAKE_PM_FAIL" ]; then echo "install failed" >&2; exit 7; fi',
      "mkdir -p node_modules/left-pad node_modules/.bin packages/web/node_modules/tiny",
      "printf 'module.exports = 1;\\n' > node_modules/left-pad/index.js",
      "printf 'tiny\\n' > packages/web/node_modules/tiny/index.js",
      "ln -s ../left-pad/index.js node_modules/.bin/left-pad",
      "ln -s ../../packages/web node_modules/web",
      "echo installed",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return { log: () => (existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : []) };
}

// 一時の nod の DB と Document の置き場。NOD_CLI には main.ts を実行する一時のシェルスクリプトを渡す
export interface TempNod {
  db: string;
  docs: string;
  env: Record<string, string>;
  run: (args: string[], cwd: string) => Promise<RunResult>;
}

export function tempNod(s: Sandbox): TempNod {
  const db = join(s.t, "nod-db", "nod.db");
  const docs = join(s.t, "nod-docs");
  mkdirSync(dirname(db), { recursive: true });
  mkdirSync(docs, { recursive: true });
  const cli = join(s.t, "nod-cli.sh");
  writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "${NOD_MAIN}" "$@"\n`);
  chmodSync(cli, 0o755);
  const env = { NOD_CLI: cli, NOD_DB: db, NOD_DOCS_DIR: docs, NOD_ORCA: "0" };
  Object.assign(s.env, env);
  return { db, docs, env, run: (args, cwd) => runNod(args, { cwd, db, env: { NOD_DOCS_DIR: docs, HOME: s.home } }) };
}

// 評価用の事例（nod を使わない固定資料）から prepare を実行し、委譲できる作業ディレクトリ W を作る。依存の写しは偽の bun で準備する
export interface PreparedWork {
  W: string;
  repo: string;
  base: string;
  head: string;
  clone: string;
}

export const CASE_REQUIREMENTS: Record<string, string> = {
  "issue.md": "# 要求の Issue\n\n- a は 1 を返す\n- 失敗を記録する\n",
  "workspace-rules.md": "# 規約\n\n- 日本語で書く\n",
};

export async function prepareCaseWork(s: Sandbox, name = "run"): Promise<PreparedWork> {
  const repo = makeGitRepo(s, `app-${name}`);
  const base = gitOut(repo, "rev-parse", "HEAD");
  fakePackageManager(s, "bun");
  const head = commit(repo, { "bun.lock": '{ "lockfileVersion": 1 }\n', "src/a.ts": "export const a = 1;\n" });
  const dir = join(s.t, `dataset/inputs/${name}`);
  const caseMd = ["# 対象", "", "- 対象リポジトリ: `/old/place/app`", `- 基点の指定: \`${base}\``, `- merge-base: \`${base}\``, `- head: \`${head}\``, "- mode: `commit`", "- Issue: NOD-1", "- 計画の出典: なし", ""].join("\n");
  const files: Record<string, string> = { "case.md": caseMd };
  for (const [p, b] of Object.entries(CASE_REQUIREMENTS)) files[`requirements/${p}`] = b;
  for (const [p, b] of Object.entries(files)) put(join(dir, p), b);
  const table = Object.entries(files).map(([p, b]) => `| \`${p}\` | \`${sha256(b)}\` | 出典 |`);
  put(join(dir, "manifest.md"), ["# 入力の指紋", "", "| ファイル | sha256 | 出典 |", "|---|---|---|", ...table, "", "## 取得できなかった資料と理由", "", "- なし", ""].join("\n"));
  const W = join(s.t, "work", name);
  const r = await runReview<{ ready: boolean }>("prepare", ["--work", W, "--case", dir, "--repo", repo], s);
  if (r.exitCode !== 0 || !r.json?.ready) throw new Error(`prepare が準備完了を返しません: ${r.stdout}${r.stderr}`);
  return { W, repo, base, head, clone: join(W, "repo") };
}

// 探索の候補1件（SKILL.md 4節の必須項目）。overrides で値を変え、null の項目は書かない
export function candidateBlock(id: string, overrides: Record<string, string | null> = {}): string {
  const fields: Record<string, string | null> = {
    軸: "Standards",
    場所: "`src/a.ts@HEAD:L1-L1`",
    起点: "今回の差分",
    到達条件: "a() を呼ぶ",
    期待動作: "1 を返す",
    破綻: "呼出元が 1 以外を受け取る",
    影響: "呼出元の集計が誤る",
    証拠: "`src/a.ts@HEAD:L1-L1` の `x | y` の分岐",
    契約の出典: "`requirements/issue.md:L3`",
    "関連する要求・契約": "なし",
    ...overrides,
  };
  const lines = Object.entries(fields)
    .filter((e): e is [string, string] => e[1] !== null)
    .map(([k, v]) => `- ${k}: ${v}`);
  return [`### ${id}`, "", ...lines, ""].join("\n");
}

// 雛形（assets/standards-handoff.md・assets/spec-handoff.md）どおりの探索の引き渡し。検査に通る形を既定にする。
// Spec 探索は、要求資料ごとのコード要求あり／なし（files）と、コード要求だけの対応表（table。状態は 充足・未充足・未確認）を書く
export function exploreHandoff(role: "standards" | "spec", p: PreparedWork, opts: { candidates?: string[]; table?: string[]; files?: string[] } = {}): string {
  const std = role === "standards";
  const candidates = opts.candidates ?? [candidateBlock(std ? "STD-1" : "SPC-1", std ? {} : { 軸: "Spec" })];
  const files = opts.files ?? ["| `requirements/issue.md` | あり |", "| `requirements/workspace-rules.md` | なし |"];
  const table = opts.table ?? [
    "| `requirements/issue.md:L3` | 未確認 | `a | b` と x|y の分岐が依存の独自パッチに従うかを決められない（独自パッチの契約が入力に無い） | SPC-1 |",
    "| `requirements/issue.md:L4` | 充足 | `src/a.ts@HEAD:L1` | なし |",
  ];
  const head = [
    `# ${std ? "Standards" : "Spec"} 探索の引き渡し`,
    "",
    "## 担当と対象",
    "",
    `- 役割: ${std ? "Standards" : "Spec"} 探索`,
    `- 定義名: code-reviewer-${role}`,
    "- 担当 ID: 不明",
    "- モデル申告: 未確認",
    `- 対象版: \`${p.clone}\`／commit／merge-base \`${p.base}\`／head \`${p.head}\``,
    "- 要求資料: `requirements/issue.md`・`requirements/workspace-rules.md`（manifest.md の sha256 と一致）",
    `- 依存の写し: \`${p.W}/deps/\`、\`bun.lock\`（manifest.md と一致）`,
    "- 終了状態: 未確認を含む",
    "",
  ];
  const middle = std
    ? ["## 規約の一覧と適用判断", "", "| 規約の出典 | 適用 | 今回の差分への適用の理由 |", "|---|---|---|", "| `requirements/workspace-rules.md:L3` | 必須 | 差分の文書に適用 |", ""]
    : [
        "## 要求資料の判別",
        "",
        "該当なし",
        "",
        "## 要求資料ごとのコード要求",
        "",
        "| 要求資料 | コード要求 |",
        "|---|---|",
        ...files,
        "",
        "## コード要求の対応表",
        "",
        "| 要求の出典 | 状態 | 証拠または不足理由 | 候補ID |",
        "|---|---|---|---|",
        ...table,
        "",
      ];
  const tail = ["## 候補", "", ...(candidates.length > 0 ? candidates : ["候補0件", ""]), "## 探索上の不足・未確認", "", "なし", "", "## 判断を見送った事項", "", "なし", ""];
  return [...head, ...middle, ...tail].join("\n");
}

// コード要求が0件の要求資料ごとの記載（両方の要求資料が なし）
export const NO_CODE_FILES = ["| `requirements/issue.md` | なし |", "| `requirements/workspace-rules.md` | なし |"];

// コード要求0件の探索の引き渡し（空の対応表と候補0件）
export const emptyHandoff = (role: "standards" | "spec", p: PreparedWork) => exploreHandoff(role, p, { candidates: [], table: [], files: NO_CODE_FILES });

// 雛形（assets/refute-verdict.md）どおりの反証の判定本文。既定は exploreHandoff の既定の両引き渡しに対して check-refute に通る形で、
// Spec 探索の L3（未確認）と L4（充足）を確定し、未確認の行 requirements/issue.md:L2 を足す（追加の印だけを付ける）。要対応は CAUSE-1（STD-1・REF-1、影響度 2）。
// clean: 要対応0件・確認が残る事項0件（STD-1・SPC-1 は棄却、反証で追加した発見なし、L3・L4 は充足）
// removed: Spec 探索の L3 の行をコード要求でないとして「表から除いた行」へ移し、関連候補 SPC-1 の採否（基点から存在（対象外））は採否一覧に残す
// empty: コード要求0件（emptyHandoff の両引き渡しに対する空の対応表）
// files: 要求資料ごとのコード要求の行（要求資料を足したとき。reachRefute の files と同じものを渡す）
export interface VerdictOptions {
  clean?: boolean;
  removed?: boolean;
  empty?: boolean;
  files?: string[];
}

export function refuteVerdict(p: PreparedWork, opts: VerdictOptions = {}): string {
  const empty = opts.empty ?? false;
  const clean = (opts.clean ?? false) || empty;
  const removed = (opts.removed ?? false) && !clean;
  const L3_REASON = "依存の独自パッチの契約が入力に無く、分岐の結論を出せない";
  const table = empty
    ? []
    : [
        ...(removed ? [] : [clean ? "| `requirements/issue.md:L3` | 充足 | `src/a.ts@HEAD:L1` | なし |" : `| \`requirements/issue.md:L3\` | 未確認 | ${L3_REASON} | SPC-1 |`]),
        "| `requirements/issue.md:L4` | 充足 | `src/a.ts@HEAD:L1` の `a | b` | なし |",
        ...(clean ? [] : ["| `requirements/issue.md:L2` | 未確認 | （追加）失敗の記録先を決める契約が要求資料に無い | なし |"]),
      ];
  const unconfirmed = clean
    ? []
    : [
        ...(removed ? [] : ["| SPC-1 | Spec | 候補 | 依存の独自パッチの契約が入力に無い | 人 | 独自パッチの契約 |", `| \`requirements/issue.md:L3\` | Spec | 要求 | ${L3_REASON} | 人 | 独自パッチの契約 |`]),
        "| `requirements/issue.md:L2` | Spec | 要求 | 失敗の記録先を決める要求資料が無い | 人 | 記録先の契約 |",
      ];
  const required = clean
    ? ["なし", "", "反証で追加した発見なし", ""]
    : [
        "### CAUSE-1: 集計が誤る",
        "",
        "- 候補 ID と発見者の区分: `STD-1`（Standards 探索）、`REF-1`（反証で追加）",
        "- 影響度: 2",
        "- 軸: Standards",
        "- 起点: 今回の差分",
        "- 契約の出典: `src/a.ts@HEAD:L1`",
        "- 関連する要求・契約: なし",
        "- 場所: `src/a.ts@HEAD:L1`",
        "- 到達条件: a() を呼ぶ",
        "- 期待動作: 1 を返す",
        "- 破綻: 呼出元が 1 以外を受け取る",
        "- 影響: 集計が誤る",
        "- 証拠: `src/a.ts@HEAD:L1`",
        "- 反証の判定理由: 固定版で確かめた",
        "",
      ];
  const decisions = empty
    ? []
    : [
        clean ? "| STD-1 | Standards 探索 | 棄却 | なし | なし | 固定版で到達しない |" : "| STD-1 | Standards 探索 | 要対応 | 3 | CAUSE-1 | 固定版で確かめた |",
        clean
          ? "| SPC-1 | Spec 探索 | 棄却 | なし | なし | 固定版で到達しない |"
          : removed
            ? "| SPC-1 | Spec 探索 | 基点から存在（対象外） | なし | なし | merge-base に同じ分岐があり、今回の要求も修正を求めていない |"
            : "| SPC-1 | Spec 探索 | 未確認 | なし | なし | 依存の独自パッチの契約が入力に無い |",
        ...(clean ? [] : ["| REF-1 | 反証で追加 | 要対応 | 2 | CAUSE-1 | 固定版で確かめた |"]),
      ];
  return [
    "# 反証の判定",
    "",
    "## 担当と対象",
    "",
    "- 役割: 反証",
    "- 定義名: code-reviewer-refute",
    "- 担当 ID: 不明",
    "- モデル申告: 未確認",
    `- 対象版: \`${p.clone}\`／commit／merge-base \`${p.base}\`／head \`${p.head}\``,
    "- 受け取った入力: `refute-input/` の各ファイル（manifest.md の sha256 と一致）",
    "- 依存の写し: manifest.md のとおり",
    "- 終了状態: 未確認を含む",
    "",
    "## 軸ごとの結果",
    "",
    `- Standards: 要対応 ${clean ? 0 : 1} 件、未確認 0 件`,
    `- Spec: 要対応 0 件、未確認 ${unconfirmed.length} 件`,
    "",
    "## 要対応（影響度の重い順）",
    "",
    ...required,
    "## 基点から存在する課題（別枠）",
    "",
    removed ? "- SPC-1: merge-base に同じ分岐があり、今回の差分は悪化させていない" : "なし",
    "",
    "## 要求資料ごとのコード要求（確定）",
    "",
    "| 要求資料 | コード要求 |",
    "|---|---|",
    ...(opts.files ?? (empty ? NO_CODE_FILES : ["| `requirements/issue.md` | あり |", "| `requirements/workspace-rules.md` | なし |"])),
    "",
    "## コード要求の対応表（確定）",
    "",
    "| 要求の出典 | 状態 | 証拠または不足理由 | 候補ID |",
    "|---|---|---|---|",
    ...table,
    "",
    "## 表から除いた行",
    "",
    ...(removed ? ["| 要求の出典 | 理由 |", "|---|---|", "| `requirements/issue.md:L3` | 背景の説明で、コードが満たす要求ではない |"] : ["なし"]),
    "",
    "## 未確認と理由",
    "",
    ...(unconfirmed.length > 0 ? ["| 要求の出典または候補ID | 軸 | 種別 | 理由 | 確かめる担当 | 不足箇所 |", "|---|---|---|---|---|---|", ...unconfirmed] : ["なし"]),
    "",
    "## 判断を見送った事項",
    "",
    "なし",
    "",
    "## 採否一覧（監査用）",
    "",
    "| 候補 ID | 発見者の区分 | 判定 | 影響度 | 同一原因 | 根拠 |",
    "|---|---|---|---|---|---|",
    ...decisions,
    "",
  ].join("\n");
}

// 両探索を委譲・検査し（empty なら emptyHandoff、それ以外は既定の引き渡し。files は Spec 探索の要求資料ごとのコード要求の行）、反証への入力を写して反証を委譲し、反証の判定本文を置いて最終返答の受領まで記録する
export async function reachRefute(s: Sandbox, p: PreparedWork, verdict: string, opts: { empty?: boolean; files?: string[] } = {}): Promise<void> {
  const W = p.W;
  const must = async (sub: string, args: string[]) => {
    const r = await runReview<{ valid?: boolean; ready?: boolean }>(sub, ["--work", W, ...args], s);
    if (r.exitCode !== 0 || r.json?.valid === false || r.json?.ready === false) throw new Error(`${sub} ${args.join(" ")} が通りません: ${r.stdout}${r.stderr}`);
  };
  for (const role of ["standards", "spec"] as const) {
    await must("agent", ["--role", role, "--event", "start"]);
    put(join(W, role, "handoff.md"), opts.empty ? emptyHandoff(role, p) : exploreHandoff(role, p, opts.files ? { files: opts.files } : {}));
    await must("agent", ["--role", role, "--event", "received", "--agent-id", `agent-${role}`]);
    await must("check-explore", ["--role", role]);
  }
  await must("refute-input", []);
  await must("agent", ["--role", "refute", "--event", "start"]);
  put(join(W, "refute/verdict.md"), verdict);
  put(join(W, "refute/notes/memo.md"), "反証のメモ\n");
  await must("agent", ["--role", "refute", "--event", "received", "--agent-id", "agent-refute"]);
}

export { git, registerRepo };
