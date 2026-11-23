// pstack を OMP 向けに使う道具の共通の部品: 固定の記録、置き場、OMP の版の確認、git の実行。
// 置き場と実行ファイルは環境変数で差し替えられる（テストと別の Mac への可搬性のため）。
//   NOD_PSTACK_OMP_PIN     固定の記録のパス（既定はこのディレクトリの pin.json）
//   NOD_DATA_DIR           nod のデータ置き場（既定は ~/.local/share/nod）。この下の pstack-omp/ に書く
//   NOD_PSTACK_OMP_OMP_BIN omp の実行ファイル（既定は PATH の omp。写しの中の専用ランチャーは飛ばす）。適用はその実パスを、写しの専用ランチャーが
//                          サンドボックスの中で起動するものとして記録する。写しの中を指していれば止める
//   NOD_PSTACK_OMP_PACKAGE OMP 向けのディレクトリの中身（既定は nod のリポジトリの omp/content）。読み替え表は <package>/skills/pstack-omp/SKILL.md
//   NOD_PSTACK_OMP_CONTROL 制御の拡張とその規則 rules.json（既定は nod のリポジトリの omp/control）
//   PI_CODING_AGENT_DIR    利用者の OMP の設定の置き場（既定は ~/.omp/agent。OMP と同じ環境変数）。設定は <dir>/config.yml。
//   PI_CONFIG_DIR・OMP_PROFILE・PI_PROFILE
//                          OMP が設定の根と profile を選ぶ環境変数。置き場は OMP と同じ決め方（omp/control/verify.ts の ompAgentDir）で決め、
//                          決められなければ（名前つきの profile、~/.omp でない設定の根）、置き場を使う apply・remove・status は止まる
//   HOME                   利用者のホーム（~/.agents/skills を名前のぶつかりとして検査する）
//   PATH                   omp の実行ファイルを探す置き場
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ompAgentDir } from "../../omp/control/verify";

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
  ompBin: string;
  // omp の実行ファイルを名前で探す置き場（PATH を : で分けたもの）
  searchPath: string[];
  // OMP 向けのディレクトリの中身（読み替え表のスキルとエージェント定義を置く）。適用で写しの content/ になる
  packageDir: string;
  // 制御の拡張（nod のリポジトリの omp/control）。適用で写しの control/ になる
  controlDir: string;
  // 利用者の OMP の設定の置き場（実パス）と決めた環境変数。決められなければ理由（置き場を使うときは userAgentDir で取る）
  agentDir: { path: string; source: string } | string;
  home: string;
}

export function loadContext(env: Record<string, string | undefined> = process.env): Context {
  const pinPath = env.NOD_PSTACK_OMP_PIN || join(import.meta.dir, "pin.json");
  const home = homedir();
  const dataDir = env.NOD_DATA_DIR || join(home, ".local", "share", "nod");
  const ompDir = join(import.meta.dir, "..", "..", "omp");
  return {
    pinPath,
    pin: loadPin(pinPath),
    workDir: resolve(dataDir, "pstack-omp"),
    ompBin: env.NOD_PSTACK_OMP_OMP_BIN || "omp",
    searchPath: (env.PATH ?? "").split(":"),
    packageDir: resolve(env.NOD_PSTACK_OMP_PACKAGE || join(ompDir, "content")),
    controlDir: resolve(env.NOD_PSTACK_OMP_CONTROL || join(ompDir, "control")),
    agentDir: ompAgentDir(env, []),
    home,
  };
}

// 利用者の OMP の設定の置き場（実パス）。決められなければ止める
export function userAgentDir(ctx: Context): string {
  if (typeof ctx.agentDir === "string") throw new PstackOmpError(`OMP の設定の置き場を決められません: ${ctx.agentDir}。何も変えずに止めます`);
  return ctx.agentDir.path;
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
  const bin = ompRealPath(ctx);
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

// omp の実行ファイルの実パス。名前だけなら PATH から探し、実パスが写し（<workDir>/omp）の中になる候補（専用ランチャー）は飛ばして
// 次の候補を使う（写しの bin を PATH の先頭に置いた端末から適用しても、ランチャーが自分自身を起動しないように）。
// パスで指定したものが写しの中なら止める。見つからなければ止める
export function ompRealPath(ctx: Context): string {
  const copy = (() => {
    try {
      return realpathSync(join(ctx.workDir, "omp"));
    } catch {
      return resolve(ctx.workDir, "omp");
    }
  })();
  const inCopy = (path: string) => path === copy || path.startsWith(`${copy}/`);
  if (ctx.ompBin.includes("/")) {
    let path: string;
    try {
      path = realpathSync(resolve(ctx.ompBin));
    } catch (e) {
      throw new PstackOmpError(`omp の実行ファイル ${ctx.ompBin} の実パスを求められません: ${(e as Error).message}`);
    }
    if (inCopy(path)) {
      throw new PstackOmpError(`omp の実行ファイル ${ctx.ompBin} が写し（${copy}）の中を指しています。専用ランチャーではなく、omp の実行ファイルを指定してください`);
    }
    return path;
  }
  for (const dir of ctx.searchPath) {
    const candidate = resolve(dir || ".", ctx.ompBin);
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isFile()) continue;
      const path = realpathSync(candidate);
      if (!inCopy(path)) return path;
    } catch {
      // 無い・実行できない候補は飛ばす
    }
  }
  throw new PstackOmpError(`omp の実行ファイル ${ctx.ompBin} が PATH にありません（写しの中の専用ランチャーを除く）`);
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// git を実行する。認証の問い合わせで止まらないよう、端末からの入力は求めさせない
export function git(cwd: string, ...args: string[]): GitResult {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdout: "pipe", stderr: "pipe" });
  return { ok: proc.exitCode === 0, stdout: proc.stdout.toString().trim(), stderr: proc.stderr.toString().trim() };
}

// 失敗したら、何をしようとしたかと git の出力を添えて止める
export function gitOrFail(what: string, cwd: string, ...args: string[]): string {
  const result = git(cwd, ...args);
  if (!result.ok) throw new PstackOmpError(`${what}に失敗しました: ${result.stderr || `git ${args.join(" ")}`}`);
  return result.stdout;
}
