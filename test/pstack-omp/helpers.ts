// pstack を OMP 向けに使う道具（scripts/pstack-omp/cli.ts）のテストの共通の部品。
// 上流は一時ディレクトリに作った git リポジトリ、固定の記録・データ置き場・omp の実行ファイル（版を出すだけの偽物）・
// OMP 向けのディレクトリの中身（読み替え表を置く）・制御の拡張（規則を差し替えるとき）・利用者の OMP の設定の置き場（PI_CODING_AGENT_DIR）・
// ホーム（HOME）も一時のものを環境変数で渡す。ネットワークとモデルの呼び出しはしない。
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../scripts/pstack-omp/cli.ts");
// nod のリポジトリの OMP 向けのディレクトリの中身と、その中の読み替え表の位置
export const REPO_CONTENT = join(import.meta.dir, "../../omp/content");
// nod のリポジトリの制御の拡張と、その規則
export const REPO_CONTROL = join(import.meta.dir, "../../omp/control");
export const REPO_RULES = join(REPO_CONTROL, "rules.json");
// メインのスレッドの制御の拡張が、検証した組の記録の sha256 を worker thread の子に渡す環境変数
export const HARNESS_ENV = "NOD_PSTACK_OMP_HARNESS_SHA256";
const TABLE = "skills/pstack-omp/SKILL.md";

export interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Pin {
  repository: string;
  commit: string;
  pstackVersion: string;
  ompVersion: string;
}

// 利用者の git の設定（global・system）に左右されないようにする
function gitEnv(root: string): Record<string, string> {
  const globalConfig = join(root, "gitconfig");
  if (!existsSync(globalConfig)) writeFileSync(globalConfig, "");
  return {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
}

function git(root: string, cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...gitEnv(root) }, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

// 案内の1行（仕様の文面そのまま）
export const GUIDE_LINE =
  "In OMP, read the `pstack-omp` skill (`skill://pstack-omp`) once per session before you follow this skill. It maps the Cursor names in pstack skills to OMP.";

// 用語のない読み替え表（表の見出しだけ）
export const EMPTY_TABLE = "# pstack-omp\n\n| Cursor | OMP |\n| --- | --- |\n";

// 検出する用語の一覧（仕様: 上流の道具の22種類と、足した4種類）。key は読み替え表の対応行の最初のセルに入れる文字列
export const TERM_KEYS = [
  "`Task`",
  "`AskQuestion`",
  "todolist",
  "generalPurpose",
  "poteto-agent",
  "comment-sicko",
  "`readonly: true`",
  '`environment: "cloud"`',
  "cloud_base_branch",
  "`run_in_background: true`",
  "`resume`",
  "`file_attachments`",
  "claude-",
  "grok-",
  "gpt-",
  "inherit-parent",
  "pstack-models.mdc",
  ".cursor/skills/",
  "~/.cursor/plugins/",
  ".cursor/rules/",
  "agent-transcripts",
  "Cursor-only features",
  "/loop",
  "origin pr",
  "subagent_type",
  "Project worker",
];

// 各用語の、上流の本文に実際にある書き方の例
export const SAMPLES: { key: string; text: string }[] = [
  { key: "`Task`", text: "Spawn one `Task` per reviewer." },
  { key: "`Task`", text: "Use the Task tool to fan out." },
  { key: "`AskQuestion`", text: "Ask the user with AskQuestion." },
  { key: "todolist", text: "Keep a todo list of the steps." },
  { key: "generalPurpose", text: "Spawn a generalPurpose worker." },
  { key: "poteto-agent", text: "Spawn it as a poteto-agent." },
  { key: "comment-sicko", text: "Hand the diff to comment-sicko." },
  { key: "`readonly: true`", text: "Explore with readonly: true." },
  { key: '`environment: "cloud"`', text: 'Run it with environment: "cloud".' },
  { key: "cloud_base_branch", text: "Set cloud_base_branch to trunk." },
  { key: "`run_in_background: true`", text: "Pass run_in_background: true." },
  { key: "`resume`", text: "Continue it with `resume`." },
  { key: "`file_attachments`", text: "Attach the log with file_attachments." },
  { key: "claude-", text: "Pick claude-opus-4 for the judge." },
  { key: "grok-", text: "Pick grok-4 for the second opinion." },
  { key: "gpt-", text: "Pick gpt-5 for the reviewer." },
  { key: "inherit-parent", text: "A line of inherit-parent keeps the parent model." },
  { key: "pstack-models.mdc", text: "Read pstack-models.mdc first." },
  { key: ".cursor/skills/", text: "Install it under .cursor/skills in the repo." },
  { key: "~/.cursor/plugins/", text: "The plugin lives in ~/.cursor/plugins/pstack." },
  { key: ".cursor/rules/", text: "Write the rule to ~/.cursor/rules." },
  { key: "agent-transcripts", text: "Read the agent-transcripts folder." },
  { key: "Cursor-only features", text: "Triage Bugbot skeptically." },
  { key: "/loop", text: "`/loop` is Cursor's built-in wake mechanism." },
  { key: "/loop", text: "Run the watcher /loop until done." },
  { key: "origin pr", text: "Read it back with `origin pr view <pr>`." },
  { key: "subagent_type", text: "Spawn it with `subagent_type: generalPurpose`." },
  { key: "Project worker", text: "Starting a Task subagent or a Project worker." },
  { key: "Project worker", text: "An explicit model per role, Project workers included." },
];

export function skillMd(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: test\n---\n\n# ${name}\n\n${body}\n`;
}

// 上流のコミットにいつも入れるファイル。cursor-team-kit は読み込む3つと、読み込まない1つ
function defaultFiles(version: string): Record<string, string> {
  return {
    "pstack/.cursor-plugin/plugin.json": JSON.stringify({ name: "pstack", version }, null, "\t") + "\n",
    "pstack/skills/poteto-mode/SKILL.md": `---\nname: poteto-mode\n---\n\n${version}\n`,
    "cursor-team-kit/skills/deslop/SKILL.md": "---\nname: deslop\n---\n\n# Deslop\n\nRemove slop.\n",
    "cursor-team-kit/skills/control-ui/SKILL.md": "---\nname: control-ui\n---\n\n# Control UI\n\nDrive the UI.\n",
    "cursor-team-kit/skills/control-cli/SKILL.md": "---\nname: control-cli\n---\n\n# Control CLI\n\nDrive the CLI.\n",
    "cursor-team-kit/skills/fix-ci/SKILL.md": "---\nname: fix-ci\n---\n\n# Fix CI\n\nFix it.\n",
  };
}

export interface Sandbox {
  root: string;
  upstream: string;
  dataDir: string;
  clone: string;
  generated: string;
  // OMP 向けのディレクトリの中身（NOD_PSTACK_OMP_PACKAGE）。repoTable の sandbox ではリポジトリの omp/content
  packageDir: string;
  // 利用者の OMP の設定の置き場（PI_CODING_AGENT_DIR）と、その config.yml
  agentDir: string;
  configPath: string;
  // 利用者のホーム（HOME）
  home: string;
  // 適用で作る写し（データ置き場の下の pstack-omp/omp）
  copy: string;
  // 上流に pstack の版 version のコミットを足し、そのコミットを返す。files は defaultFiles に重ねる。executables は実行属性を付けるパス
  commit(version: string, files?: Record<string, string>, executables?: string[]): string;
  // 固定の記録を書く。省いた項目は既定（一時の上流・最後のコミット・その版・OMP 19.1.0）
  pin(over?: Partial<Pin>): void;
  // omp --version が出す版を決める。null なら omp を失敗させる
  omp(version: string | null): void;
  // 読み替え表（OMP 向けのディレクトリの skills/pstack-omp/SKILL.md）を書く。null なら消す。repoTable の sandbox では使えない
  table(content: string | null): void;
  // OMP 向けのディレクトリの中身にファイルを書く（エージェント定義など）。repoTable の sandbox では使えない
  content(path: string, text: string): void;
  // 制御の拡張を、リポジトリの omp/control を写したものに差し替え、その規則（rules.json）を書く（NOD_PSTACK_OMP_CONTROL）
  rules(text: string): void;
  // 道具のサブコマンドを起動する。cwd は実行するディレクトリ（既定は一時ディレクトリの root）
  run(command: string, options?: { cwd?: string; dataDir?: string }): Promise<Run>;
  // 同期を起動する。dataDir を渡すとそのデータ置き場を使う
  sync(dataDir?: string): Promise<Run>;
  cloneHead(): string;
  cloneStatus(): string;
}

// repoTable: OMP 向けのディレクトリを差し替えず、既定（nod のリポジトリの omp/content）の実際の読み替え表で生成する
export function sandbox({ repoTable = false }: { repoTable?: boolean } = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "nod-pstack-omp-"));
  created.push(root);
  const upstream = join(root, "upstream-src");
  const dataDir = join(root, "data");
  const pinPath = join(root, "pin.json");
  const ompBin = join(root, "omp");
  const packageDir = repoTable ? REPO_CONTENT : join(root, "omp-package");
  const agentDir = join(root, "omp-agent");
  const home = join(root, "home");
  const controlDir = join(root, "omp-control");
  mkdirSync(upstream);
  mkdirSync(home);
  git(root, upstream, "init", "-q", "-b", "main");
  let last = { commit: "", version: "" };

  const sb: Sandbox = {
    root,
    upstream,
    dataDir,
    clone: join(dataDir, "pstack-omp", "upstream"),
    generated: join(dataDir, "pstack-omp", "generated"),
    packageDir,
    agentDir,
    configPath: join(agentDir, "config.yml"),
    home,
    copy: join(dataDir, "pstack-omp", "omp"),
    commit(version, files = {}, executables = []) {
      for (const [path, content] of Object.entries({ ...defaultFiles(version), ...files })) {
        mkdirSync(join(upstream, path, ".."), { recursive: true });
        writeFileSync(join(upstream, path), content);
        chmodSync(join(upstream, path), executables.includes(path) ? 0o755 : 0o644);
      }
      git(root, upstream, "add", "-A");
      git(root, upstream, "commit", "-q", "-m", `pstack ${version}`);
      last = { commit: git(root, upstream, "rev-parse", "HEAD"), version };
      return last.commit;
    },
    pin(over = {}) {
      const pin: Pin = { repository: upstream, commit: last.commit, pstackVersion: last.version, ompVersion: "19.1.0", ...over };
      writeFileSync(pinPath, JSON.stringify(pin, null, 2) + "\n");
    },
    omp(version) {
      writeFileSync(ompBin, version === null ? "#!/bin/sh\necho 'omp: 壊れている' >&2\nexit 3\n" : `#!/bin/sh\necho 'omp/${version}'\n`);
      chmodSync(ompBin, 0o755);
    },
    table(content) {
      if (content === null) {
        if (repoTable) throw new Error("repoTable の sandbox ではリポジトリの読み替え表を使うので、表を書き換えない");
        rmSync(join(packageDir, TABLE), { force: true });
        return;
      }
      sb.content(TABLE, content);
    },
    content(path, text) {
      if (repoTable) throw new Error("repoTable の sandbox ではリポジトリの OMP 向けのディレクトリを使うので、中身を書き換えない");
      mkdirSync(join(packageDir, path, ".."), { recursive: true });
      writeFileSync(join(packageDir, path), text);
    },
    rules(text) {
      if (!existsSync(controlDir)) cpSync(REPO_CONTROL, controlDir, { recursive: true });
      writeFileSync(join(controlDir, "rules.json"), text);
    },
    async run(command, { cwd = root, dataDir: dir = dataDir } = {}) {
      const env: Record<string, string | undefined> = {
        ...process.env,
        ...gitEnv(root),
        NOD_DATA_DIR: dir,
        NOD_PSTACK_OMP_PIN: pinPath,
        NOD_PSTACK_OMP_OMP_BIN: ompBin,
        NOD_PSTACK_OMP_PACKAGE: packageDir,
        PI_CODING_AGENT_DIR: agentDir,
        HOME: home,
      };
      if (repoTable) delete env.NOD_PSTACK_OMP_PACKAGE;
      if (existsSync(controlDir)) env.NOD_PSTACK_OMP_CONTROL = controlDir;
      const proc = Bun.spawn([process.execPath, CLI, command], { cwd, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { exitCode, stdout, stderr };
    },
    sync: (dir = dataDir) => sb.run("sync", { dataDir: dir }),
    cloneHead: () => git(root, sb.clone, "rev-parse", "HEAD"),
    cloneStatus: () => git(root, sb.clone, "status", "--porcelain", "--ignored"),
  };
  sb.omp("19.1.0");
  if (!repoTable) sb.table(EMPTY_TABLE);
  return sb;
}

export interface Entry {
  content: string;
  executable: boolean;
}

// ディレクトリの下の全ファイル（相対パス → 中身と実行属性）。パスの順に並べる
export function snapshot(dir: string): Map<string, Entry> {
  const files = new Map<string, Entry>();
  const visit = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const stat = statSync(join(dir, path));
      if (stat.isDirectory()) visit(path);
      else files.set(path, { content: readFileSync(join(dir, path), "base64"), executable: (stat.mode & 0o111) !== 0 });
    }
  };
  visit("");
  return files;
}

// スキルとして読まれる <dir>/*/SKILL.md のスキルの名前（OMP は skills.customDirectories を非再帰で読む）
export function skillNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "SKILL.md")))
    .sort();
}

// 親のディレクトリを作ってから書く
export function put(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

// 上流に pstack の tdd と poteto-mode、cursor-team-kit の3つを置き、固定の記録どおりに同期した sandbox
export async function synced(): Promise<Sandbox> {
  const sb = sandbox();
  sb.commit("0.15.46", { "pstack/skills/tdd/SKILL.md": skillMd("tdd", "Red, green.") });
  sb.pin();
  const run = await sb.sync();
  if (run.exitCode !== 0) throw new Error(`同期に失敗: ${run.stderr}`);
  return sb;
}

// 書き込み権限を外した写しを、テストで壊すために書けるようにする（パスと、その親のディレクトリ）
export function writable(path: string): void {
  chmodSync(join(path, ".."), 0o755);
  if (existsSync(path)) chmodSync(path, statSync(path).isDirectory() ? 0o755 : 0o644);
}

const created: string[] = [];

// 作った sandbox の中の全ディレクトリを書けるようにする（適用の写しは書き込み権限を外すので、そのままでは実行の後に一時ディレクトリを消せない）。
// 適用するテストのファイルは afterAll でこれを呼ぶ
export function unlockSandboxes(): void {
  const visit = (dir: string): void => {
    chmodSync(dir, 0o755);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) visit(path);
    }
  };
  for (const root of created.splice(0)) if (existsSync(root)) visit(root);
}

export interface ToolCall {
  toolName: string;
  input: unknown;
}

export interface ExtensionScenario {
  // 拡張が読む設定のいまの実効値（global・project・--config を合わせたもの）
  settings: Record<string, unknown>;
  // settings の値がどの層から来たか（既定は global）。実行時の上書きをした値は runtime になる
  provenance?: string;
  // true なら、設定が worker thread の子のもの（メインのスレッドの設定の写しの上に重なった層）になる
  mirror?: boolean;
  // 拡張を読み込む前に足す環境変数（worker thread の子がメインのスレッドから受け継ぐもの）
  env?: Record<string, string>;
  // ctx.cwd（既定はこのプロセスの cwd）
  cwd?: string;
  // 順に始めるセッション。agent は ctx.agent（null なら無い）。toolCalls はそのセッションで呼ぶツール（数なら bash の ls をその回数）。
  // spawns は、そのセッションが起動しようとする子のエージェントの名前（before_subagent_spawn に渡す）
  sessions: { agent: { kind: "main" | "sub"; name: string; depth: number } | null; toolCalls: number | ToolCall[]; spawns?: string[] }[];
}

export type Blocked = { block: boolean; reason: string } | null;

export interface ExtensionResult {
  // 拡張がした実行時の上書き（順に）。session は何番目のセッションか、phase はそのセッションのどの時点か
  overrides: { id: string; value: unknown; session: number; phase: "factory" | "session_start" | "tool_call" }[];
  // 全セッションの後の実効値
  effective: Record<string, unknown>;
  // セッションごとの、factory の後で session_start の前の実効値（OMP がメインの task ツールを作り、エージェント定義を探す時点）
  effectiveAtStart: Record<string, unknown>[];
  // セッションごとに、拡張が message renderer を登録した customType
  renderers: string[][];
  // セッションごとの tool_call の戻り値（遮断しなければ null）
  toolCalls: Blocked[][];
  // セッションごとの before_subagent_spawn の戻り値（拒否しなければ null）
  spawns: Blocked[][];
  notices: string[];
  // 全セッションの後の、worker thread の子に渡る環境変数（HARNESS_ENV）の値
  harnessEnv: string | null;
}

export const MAIN = { kind: "main", name: "main", depth: 0 } as const;
export const SUB = { kind: "sub", name: "poteto-agent", depth: 1 } as const;

// 制御の拡張を OMP の代わりに読み込むプロセスを起動する（extension-driver.ts）。プロセスの開始はここで決まり、
// run でシナリオを渡したときに拡張を読み込む
export function startExtension(index: string): { run(scenario: ExtensionScenario): Promise<ExtensionResult> } {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "extension-driver.ts"), index], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return {
    async run(scenario) {
      proc.stdin.write(JSON.stringify(scenario));
      await proc.stdin.end();
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (exitCode !== 0) throw new Error(`拡張を動かすプロセスが ${exitCode} で終了: ${stderr}`);
      return JSON.parse(stdout) as ExtensionResult;
    },
  };
}
