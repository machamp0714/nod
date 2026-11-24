// pstack を OMP 向けに使う道具の共通の部品: 固定の記録、置き場、OMP の版の確認、git の実行。
// 置き場と実行ファイルは環境変数で差し替えられる（テストと別の Mac への可搬性のため）。
//   NOD_PSTACK_OMP_PIN     固定の記録のパス（既定はこのディレクトリの pin.json）
//   NOD_DATA_DIR           nod のデータ置き場（既定は ~/.local/share/nod）。この下の pstack-omp/ に書く（上流の clone と固定の生成先 generated/）
//   NOD_PSTACK_OMP_OMP_BIN omp の実行ファイル（既定は PATH の omp）。版の確認だけに使う
//   NOD_PSTACK_OMP_PACKAGE OMP 向けのディレクトリの中身（既定は nod のリポジトリの omp/content）。読み替え表は <package>/skills/pstack-omp/SKILL.md
//   PI_CODING_AGENT_DIR    利用者の OMP の設定の置き場（既定は ~/.omp/agent。OMP と同じ環境変数）。設定は <dir>/config.yml（無ければ config.yaml）。
//                          status が読むだけで、書かない
//   PI_CONFIG_DIR・OMP_PROFILE・PI_PROFILE
//                          OMP が設定の根と profile を選ぶ環境変数。置き場は ompAgentDir で決め、決められなければ（名前つきの profile、
//                          ~/.omp でない設定の根）、置き場を読む status は止まる
//   HOME                   利用者のホーム（~ の展開と、通常の omp が読む ~/.agent/skills・~/.agents/skills などの利用者の置き場）
//   PATH                   omp の実行ファイルを探す置き場
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { realAncestor } from "./config";

// 道具が止まる理由。cli.ts が標準エラーに出して 1 で終わる
export class PstackOmpError extends Error {}

export interface Pin {
  repository: string;
  commit: string;
  pstackVersion: string;
  ompVersion: string;
}

export interface Context {
  pinPath: string;
  pin: Pin;
  // データ置き場の下の pstack-omp/
  workDir: string;
  // omp の実行ファイル（パスか、PATH から探す名前）
  ompBin: string;
  // OMP 向けのディレクトリの中身（読み替え表のスキルとエージェント定義を置く）。利用者が extensions に登録し、通常の omp がここを直接読む
  packageDir: string;
  // 利用者の OMP の設定の置き場（実パス）。決められなければ理由（置き場を使うときは userAgentDir で取る）
  agentDir: { path: string } | string;
  home: string;
}

export function loadContext(env: Record<string, string | undefined> = process.env): Context {
  const pinPath = env.NOD_PSTACK_OMP_PIN || join(import.meta.dir, "pin.json");
  const home = homedir();
  const dataDir = env.NOD_DATA_DIR || join(home, ".local", "share", "nod");
  return {
    pinPath,
    pin: loadPin(pinPath),
    workDir: resolve(dataDir, "pstack-omp"),
    ompBin: env.NOD_PSTACK_OMP_OMP_BIN || "omp",
    packageDir: resolve(env.NOD_PSTACK_OMP_PACKAGE || join(import.meta.dir, "..", "..", "omp", "content")),
    agentDir: ompAgentDir(env, home),
    home,
  };
}

// 利用者の OMP の設定の置き場（実パス）。決められなければ止める
export function userAgentDir(ctx: Context): string {
  if (typeof ctx.agentDir === "string") throw new PstackOmpError(`OMP の設定の置き場を決められません: ${ctx.agentDir}。何も変えずに止めます`);
  return ctx.agentDir.path;
}

// OMP の名前つきの profile の名前の形（これに合わない名前は、OMP がどう扱うかを固定版の契約から決められない）
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]*$/u;

// いまの OMP の設定の置き場の実パス。OMP 19.1.0 の契約（Document 1683 の論点 12、settings.md、
// config-usage.md）から決まる範囲だけで決め、決められなければ理由を返す。
// - PI_CONFIG_DIR が空でも .omp でもなければ決めない（OMP の設定の根が ~/.omp から変わる）。
// - profile は、定義された（空でも）OMP_PROFILE、無ければ PI_PROFILE で選ぶ。空・空白だけ・default は既定の profile。ほかは名前つきの
//   profile で、決めない（名前つきの profile は OMP の利用者の根を移し、その置き場を契約から決められない）。
// - 既定の profile では、空でない PI_CODING_AGENT_DIR（OMP と同じく resolve する）、無ければ ~/.omp/agent。ただし PI_PROFILE が名前つきの P なら、
//   P が名前の形に合わなければ決めず、PI_CODING_AGENT_DIR が ~/.omp/profiles/P/agent と同じなら、profile から引き継いだ値として使わない。
function ompAgentDir(env: Record<string, string | undefined>, home: string): { path: string } | string {
  const root = env.PI_CONFIG_DIR;
  if (root !== undefined && root !== "" && root !== ".omp") {
    return `環境変数 PI_CONFIG_DIR（${root}）で OMP の設定の根が ~/.omp から変わっています。OMP がどの置き場の設定を読むかを固定版の契約から決められません`;
  }
  const named = (value: string) => value.trim() !== "" && value !== "default";
  const variable = env.OMP_PROFILE !== undefined ? "OMP_PROFILE" : env.PI_PROFILE !== undefined ? "PI_PROFILE" : undefined;
  const chosen = variable === undefined ? undefined : env[variable]!;
  if (chosen !== undefined && named(chosen)) {
    return `環境変数 ${variable} で名前つきの profile（${chosen}）が選ばれています。名前つきの profile では、OMP がどの置き場の設定を読むかを固定版の契約から決められません`;
  }
  const override = env.PI_CODING_AGENT_DIR;
  if (!override) return { path: realAncestor(join(home, ".omp", "agent")) };
  const legacy = env.PI_PROFILE;
  if (legacy !== undefined && named(legacy)) {
    if (!PROFILE_NAME.test(legacy)) {
      return `環境変数 PI_PROFILE（${legacy}）が置き場を決められない profile の名前なので、PI_CODING_AGENT_DIR（${override}）がその profile から引き継いだ値かを確かめられません`;
    }
    // PI_CODING_AGENT_DIR が PI_PROFILE の profile から引き継いだ値なら使わない
    if (override === join(home, ".omp", "profiles", legacy, "agent")) return { path: realAncestor(join(home, ".omp", "agent")) };
  }
  return { path: realAncestor(resolve(override)) };
}

function loadPin(path: string): Pin {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new PstackOmpError(`固定の記録 ${path} を読めません: ${(e as Error).message}`);
  }
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const field = (key: keyof Pin): string => {
    const value = record[key];
    if (typeof value !== "string" || value === "") throw new PstackOmpError(`固定の記録 ${path} に ${key} がありません`);
    return value;
  };
  const pin: Pin = { repository: field("repository"), commit: field("commit"), pstackVersion: field("pstackVersion"), ompVersion: field("ompVersion") };
  if (!/^[0-9a-f]{40}$/.test(pin.commit)) throw new PstackOmpError(`固定の記録 ${path} の commit が40桁のコミットではありません: ${pin.commit}`);
  return pin;
}

// omp --version（omp/19.1.0 の形）の版。確かめられなければ止める
export function readOmpVersion(ctx: Context): string {
  const bin = ctx.ompBin;
  const proc = (() => {
    try {
      return Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      throw new PstackOmpError(`OMP の版を確かめられません（${bin} --version を起動できない）: ${(e as Error).message}`);
    }
  })();
  const stdout = proc.stdout.toString().trim();
  if (proc.exitCode !== 0) {
    throw new PstackOmpError(`OMP の版を確かめられません（${bin} --version が ${proc.exitCode} で終了）: ${proc.stderr.toString().trim()}`);
  }
  const version = /^omp\/(\S+)$/.exec(stdout)?.[1];
  if (version === undefined) throw new PstackOmpError(`OMP の版を読めません（${bin} --version の出力: ${stdout}）`);
  return version;
}

// OMP の版が固定の記録の OMP の版と同じでなければ止める。同じなら版を返す
export function checkOmpVersion(ctx: Context): string {
  const version = readOmpVersion(ctx);
  if (version !== ctx.pin.ompVersion) {
    throw new PstackOmpError(
      `OMP の版 ${version} が固定の記録（${ctx.pinPath}）の ${ctx.pin.ompVersion} と違います。確かめていない組み合わせなので止めます。` +
        `OMP の版を合わせるか、確かめた上で固定の記録を更新してください`,
    );
  }
  return version;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// 呼び出し元のリポジトリを指す環境変数。git が別のリポジトリでコマンドを動かすとき（run-command.c の prepare_other_repo_env）と同じく、
// git rev-parse --local-env-vars のうち、環境変数で渡した設定（GIT_CONFIG_PARAMETERS、GIT_CONFIG_COUNT とその GIT_CONFIG_KEY_n・GIT_CONFIG_VALUE_n）は除く
const KEPT_ENV_VARS = ["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"];
let localEnvVars: string[] | undefined;

function gitLocalEnvVars(): string[] {
  if (localEnvVars) return localEnvVars;
  const proc = Bun.spawnSync(["git", "rev-parse", "--local-env-vars"], { cwd: "/", stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new PstackOmpError(`git の環境変数の一覧（git rev-parse --local-env-vars）を得られません: ${proc.stderr.toString().trim() || `終了コード ${proc.exitCode}`}`);
  }
  localEnvVars = proc.stdout
    .toString()
    .split("\n")
    .filter((key) => key !== "" && !KEPT_ENV_VARS.includes(key));
  return localEnvVars;
}

// git を実行する。認証の問い合わせで止まらないよう、端末からの入力は求めさせない。
// 呼び出し元のリポジトリを指す環境変数（GIT_DIR・GIT_WORK_TREE・GIT_INDEX_FILE など）は渡さないので、フックの中などから同期しても
// cwd の clone だけに触る。利用者のほかの git の設定（環境変数で渡した設定、GIT_CONFIG_GLOBAL・GIT_SSH_COMMAND など）は取得のために残す
// （packages/core/src/ops/git-runner.ts のように GIT_ で始まるものを全部は消さない）
export function git(cwd: string, ...args: string[]): GitResult {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of gitLocalEnvVars()) delete env[key];
  const proc = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { ok: proc.exitCode === 0, stdout: proc.stdout.toString().trim(), stderr: proc.stderr.toString().trim() };
}

// 失敗したら、何をしようとしたかと git の出力を添えて止める
export function gitOrFail(what: string, cwd: string, ...args: string[]): string {
  const result = git(cwd, ...args);
  if (!result.ok) throw new PstackOmpError(`${what}に失敗しました: ${result.stderr || `git ${args.join(" ")}`}`);
  return result.stdout;
}
