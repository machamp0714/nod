// 固定の記録どおりに上流を取得する。置き場はデータ置き場の下の pstack-omp/upstream（nod のリポジトリの外）。
// 既存の clone があれば再利用し、無いコミットだけ取り寄せて、記録したコミットの作業ツリーに揃える。
// 新しく clone するときは同じ階層の一時ディレクトリに取得し、確かめ終えてから置き換える。途中で失敗したら一時ディレクトリを消すので、
// 壊れた clone は残らない。既存の clone は、コミットと pstack の版を確かめ終えるまで作業ツリーに触らない。
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Context, git, gitOrFail, type Pin, PstackOmpError } from "./context";

// pstack の版を持つ上流のファイル
const PSTACK_MANIFEST = "pstack/.cursor-plugin/plugin.json";

export interface Upstream {
  dir: string;
  // 新しく clone したか（false なら既存の clone を揃えた）
  cloned: boolean;
}

export function fetchUpstream(ctx: Context): Upstream {
  const dir = join(ctx.workDir, "upstream");
  if (existsSync(dir)) {
    checkExistingClone(ctx.pin, dir);
    checkoutPinned(ctx.pin, dir);
    return { dir, cloned: false };
  }
  mkdirSync(ctx.workDir, { recursive: true });
  const staging = mkdtempSync(join(ctx.workDir, ".upstream-"));
  try {
    gitOrFail(`上流 ${ctx.pin.repository} の clone`, ctx.workDir, "clone", "--quiet", "--no-checkout", ctx.pin.repository, staging);
    checkoutPinned(ctx.pin, staging);
    renameSync(staging, dir);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  return { dir, cloned: true };
}

// 既存の置き場が、記録した上流の clone であることを確かめる。違えば触らずに止める
function checkExistingClone(pin: Pin, dir: string): void {
  const top = statSync(dir).isDirectory() ? git(dir, "rev-parse", "--show-toplevel") : undefined;
  if (!top?.ok || realpathSync(top.stdout) !== realpathSync(dir)) {
    throw new PstackOmpError(`${dir} が git の clone ではありません。中身を確かめて退かしてから、もう一度同期してください`);
  }
  const origin = git(dir, "config", "--get", "remote.origin.url");
  if (origin.stdout !== pin.repository) {
    throw new PstackOmpError(
      `${dir} の origin（${origin.stdout || "なし"}）が固定の記録のリポジトリ ${pin.repository} と違います。中身を確かめて退かしてから、もう一度同期してください`,
    );
  }
}

// 記録したコミットを手元に揃え、pstack の版を確かめてから、そのコミットの作業ツリーにする
function checkoutPinned(pin: Pin, dir: string): void {
  const present = () => git(dir, "cat-file", "-e", `${pin.commit}^{commit}`).ok;
  if (!present()) {
    gitOrFail(`上流 ${pin.repository} からの取得`, dir, "fetch", "--quiet", "--tags", "origin");
    // 枝やタグから辿れないコミットは、コミットを名指しして取り寄せる（上流が許していれば取れる）
    if (!present()) git(dir, "fetch", "--quiet", "origin", pin.commit);
    if (!present()) throw new PstackOmpError(`上流 ${pin.repository} に固定の記録のコミット ${pin.commit} がありません`);
  }
  const manifest = git(dir, "show", `${pin.commit}:${PSTACK_MANIFEST}`);
  if (!manifest.ok) throw new PstackOmpError(`コミット ${pin.commit} に ${PSTACK_MANIFEST} がありません`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.stdout);
  } catch (e) {
    throw new PstackOmpError(`コミット ${pin.commit} の ${PSTACK_MANIFEST} を読めません: ${(e as Error).message}`);
  }
  const version = typeof parsed === "object" && parsed !== null && "version" in parsed ? parsed.version : undefined;
  if (version !== pin.pstackVersion) {
    throw new PstackOmpError(`コミット ${pin.commit} の pstack の版 ${String(version)} が固定の記録の ${pin.pstackVersion} と違います`);
  }
  gitOrFail(`コミット ${pin.commit} の checkout`, dir, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", "--detach", pin.commit);
  gitOrFail("作業ツリーの掃除", dir, "clean", "-ffdxq");
}
