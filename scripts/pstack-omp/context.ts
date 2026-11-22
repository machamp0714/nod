// pstack を OMP 向けに使う道具の共通の部品: 固定の記録、データ置き場、OMP の版の確認、git の実行。
// 置き場と実行ファイルは環境変数で差し替えられる（テストと別の Mac への可搬性のため）。
//   NOD_PSTACK_OMP_PIN     固定の記録のパス（既定はこのディレクトリの pin.json）
//   NOD_DATA_DIR           nod のデータ置き場（既定は ~/.local/share/nod）。この下の pstack-omp/ に書く
//   NOD_PSTACK_OMP_OMP_BIN omp の実行ファイル（既定は PATH の omp）
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
}

export function loadContext(env: Record<string, string | undefined> = process.env): Context {
  const pinPath = env.NOD_PSTACK_OMP_PIN || join(import.meta.dir, "pin.json");
  const dataDir = env.NOD_DATA_DIR || join(homedir(), ".local", "share", "nod");
  return { pinPath, pin: loadPin(pinPath), workDir: join(dataDir, "pstack-omp"), ompBin: env.NOD_PSTACK_OMP_OMP_BIN || "omp" };
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

// omp --version（omp/19.1.0 の形）が固定の記録の OMP の版と同じでなければ止める
export function checkOmpVersion(ctx: Context): void {
  const proc = (() => {
    try {
      return Bun.spawnSync([ctx.ompBin, "--version"], { stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      throw new PstackOmpError(`OMP の版を確かめられません（${ctx.ompBin} --version を起動できない）: ${(e as Error).message}`);
    }
  })();
  const stdout = proc.stdout.toString().trim();
  if (proc.exitCode !== 0) {
    throw new PstackOmpError(`OMP の版を確かめられません（${ctx.ompBin} --version が ${proc.exitCode} で終了）: ${proc.stderr.toString().trim()}`);
  }
  const version = /^omp\/(\S+)$/.exec(stdout)?.[1];
  if (version === undefined) throw new PstackOmpError(`OMP の版を読めません（${ctx.ompBin} --version の出力: ${stdout}）`);
  if (version !== ctx.pin.ompVersion) {
    throw new PstackOmpError(
      `OMP の版 ${version} が固定の記録（${ctx.pinPath}）の ${ctx.pin.ompVersion} と違います。確かめていない組み合わせなので止めます。` +
        `OMP の版を合わせるか、確かめた上で固定の記録を更新してください`,
    );
  }
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
