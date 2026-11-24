// pstack を OMP 向けに使う道具（scripts/pstack-omp/cli.ts）のテストの共通の部品。
// 上流は一時ディレクトリに作った git リポジトリ、固定の記録・データ置き場・omp の実行ファイル（版を出す偽物）・
// OMP 向けのディレクトリの中身（読み替え表を置く）・ホーム（HOME）と、その下の利用者の OMP の設定の置き場
// （PI_CODING_AGENT_DIR。既定と同じ <home>/.omp/agent）・作業中のプロジェクトも一時のものを環境変数と作業ディレクトリで渡す。
// ネットワークとモデルの呼び出しはしない。
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../scripts/pstack-omp/cli.ts");
// nod のリポジトリの OMP 向けのディレクトリの中身と、その中の読み替え表の位置
export const REPO_CONTENT = join(import.meta.dir, "../../omp/content");
const TABLE = "skills/pstack-omp/SKILL.md";
// OMP の設定の根・profile・設定の重ねを選ぶ環境変数。テストを動かす端末の値を引き継がない（テストが足すときだけ使う）
const SELECTORS = ["PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_FILES"];

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

export function git(root: string, cwd: string, ...args: string[]): string {
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
  // 利用者のホーム（HOME）
  home: string;
  // 利用者の OMP の設定の置き場（PI_CODING_AGENT_DIR。<home>/.omp/agent）と、その config.yml
  agentDir: string;
  configPath: string;
  // 作業中のプロジェクト
  project: string;
  // 適用で作る写し（データ置き場の下の pstack-omp/omp）
  copy: string;
  // omp の実行ファイル（NOD_PSTACK_OMP_OMP_BIN）
  ompBin: string;
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
  // 道具のサブコマンドを起動する。cwd は実行するディレクトリ（既定は一時ディレクトリの root）。env は環境変数を足す（undefined なら消す）
  run(command: string, options?: { cwd?: string; dataDir?: string; env?: Record<string, string | undefined> }): Promise<Run>;
  // 同期を起動する。dataDir を渡すとそのデータ置き場を使う
  sync(dataDir?: string): Promise<Run>;
  cloneHead(): string;
  cloneStatus(): string;
}

// repoTable: OMP 向けのディレクトリを差し替えず、既定（nod のリポジトリの omp/content）の実際の読み替え表で生成する
export function sandbox({ repoTable = false }: { repoTable?: boolean } = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "nod-pstack-omp-"));
  const upstream = join(root, "upstream-src");
  const dataDir = join(root, "data");
  const pinPath = join(root, "pin.json");
  const ompBin = join(root, "omp");
  const packageDir = repoTable ? REPO_CONTENT : join(root, "omp-package");
  const home = join(root, "home");
  const agentDir = join(home, ".omp", "agent");
  const project = join(root, "project");
  mkdirSync(upstream);
  mkdirSync(home);
  mkdirSync(project);
  git(root, upstream, "init", "-q", "-b", "main");
  let last = { commit: "", version: "" };

  const sb: Sandbox = {
    root,
    upstream,
    dataDir,
    clone: join(dataDir, "pstack-omp", "upstream"),
    generated: join(dataDir, "pstack-omp", "generated"),
    packageDir,
    home,
    agentDir,
    configPath: join(agentDir, "config.yml"),
    project,
    copy: join(dataDir, "pstack-omp", "omp"),
    ompBin,
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
      writeFileSync(
        ompBin,
        version === null ? "#!/bin/sh\necho 'omp: 壊れている' >&2\nexit 3\n" : `#!/bin/sh\nif [ "$1" = --version ]; then echo 'omp/${version}'; exit 0; fi\nexit 0\n`,
      );
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
    async run(command, { cwd = root, dataDir: dir = dataDir, env = {} } = {}) {
      return spawn([process.execPath, CLI, command], cwd, dir, env);
    },
    sync: (dir = dataDir) => sb.run("sync", { dataDir: dir }),
    cloneHead: () => git(root, sb.clone, "rev-parse", "HEAD"),
    cloneStatus: () => git(root, sb.clone, "status", "--porcelain", "--ignored"),
  };
  async function spawn(argv: string[], cwd: string, dir: string, extra: Record<string, string | undefined>): Promise<Run> {
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
    for (const key of SELECTORS) delete env[key];
    // OMP が Claude Code の利用者の置き場（~/.claude）を差し替えて読む環境変数。テストを動かす端末の値を引き継がない（テストが足すときだけ使う）
    delete env.CLAUDE_CONFIG_DIR;
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stdout, stderr };
  }
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
  if (run.exitCode !== 0) throw new Error(`同期に失敗（${run.exitCode}）: ${run.stderr}${run.stdout}`);
  return sb;
}
