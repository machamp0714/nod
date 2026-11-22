// pstack を OMP 向けに使う道具（scripts/pstack-omp/cli.ts）のテストの共通の部品。
// 上流は一時ディレクトリに作った git リポジトリ、固定の記録・データ置き場・omp の実行ファイル（版を出すだけの偽物）・
// OMP 向けのディレクトリ（読み替え表を置く）も一時のものを環境変数で渡す。ネットワークとモデルの呼び出しはしない。
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../scripts/pstack-omp/cli.ts");

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
  // 上流に pstack の版 version のコミットを足し、そのコミットを返す。files は defaultFiles に重ねる。executables は実行属性を付けるパス
  commit(version: string, files?: Record<string, string>, executables?: string[]): string;
  // 固定の記録を書く。省いた項目は既定（一時の上流・最後のコミット・その版・OMP 19.1.0）
  pin(over?: Partial<Pin>): void;
  // omp --version が出す版を決める。null なら omp を失敗させる
  omp(version: string | null): void;
  // 読み替え表（OMP 向けのディレクトリの skills/pstack-omp/SKILL.md）を書く。null なら消す。repoTable の sandbox では使えない
  table(content: string | null): void;
  // 同期を起動する。dataDir を渡すとそのデータ置き場を使う
  sync(dataDir?: string): Promise<Run>;
  cloneHead(): string;
  cloneStatus(): string;
}

// repoTable: OMP 向けのディレクトリを差し替えず、既定（nod のリポジトリの omp/）の実際の読み替え表で生成する
export function sandbox({ repoTable = false }: { repoTable?: boolean } = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "nod-pstack-omp-"));
  const upstream = join(root, "upstream-src");
  const dataDir = join(root, "data");
  const pinPath = join(root, "pin.json");
  const ompBin = join(root, "omp");
  const packageDir = join(root, "omp-package");
  const tablePath = join(packageDir, "skills", "pstack-omp", "SKILL.md");
  mkdirSync(upstream);
  git(root, upstream, "init", "-q", "-b", "main");
  let last = { commit: "", version: "" };

  const sb: Sandbox = {
    root,
    upstream,
    dataDir,
    clone: join(dataDir, "pstack-omp", "upstream"),
    generated: join(dataDir, "pstack-omp", "generated"),
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
      if (repoTable) throw new Error("repoTable の sandbox ではリポジトリの読み替え表を使うので、表を書き換えない");
      if (content === null) {
        rmSync(tablePath, { force: true });
        return;
      }
      mkdirSync(join(tablePath, ".."), { recursive: true });
      writeFileSync(tablePath, content);
    },
    async sync(dir = dataDir) {
      const env: Record<string, string | undefined> = {
        ...process.env,
        ...gitEnv(root),
        NOD_DATA_DIR: dir,
        NOD_PSTACK_OMP_PIN: pinPath,
        NOD_PSTACK_OMP_OMP_BIN: ompBin,
        NOD_PSTACK_OMP_PACKAGE: packageDir,
      };
      if (repoTable) delete env.NOD_PSTACK_OMP_PACKAGE;
      const proc = Bun.spawn([process.execPath, CLI, "sync"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { exitCode, stdout, stderr };
    },
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
