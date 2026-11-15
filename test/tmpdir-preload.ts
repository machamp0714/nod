// bun test の実行ごとに TMPDIR を専用ディレクトリへ隔離し、終了時に丸ごと消す（#147）。
// helper や個別テストの mkdtempSync(tmpdir()) はすべて隔離先に入り、子プロセスも TMPDIR を引き継ぐ。
// SIGKILL などで消せなかった隔離先は、次回起動時に持ち主のプロセスが居ないものだけ回収する。
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

export const RUN_PREFIX = "nod-testrun-";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// base 直下の nod-testrun-<pid>-* のうち、pid のプロセスが居ないものを消す。消せた名前を返す。
export function sweepStale(base: string): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return removed;
  }
  for (const name of names) {
    const m = name.startsWith(RUN_PREFIX) ? /^(\d+)-/.exec(name.slice(RUN_PREFIX.length)) : null;
    if (!m || Number(m[1]) === process.pid || alive(Number(m[1]))) continue;
    // 消せない残骸（権限・同時に回収した別の実行との競合）があってもテストの起動は止めず、次回に回す
    try {
      rmSync(join(base, name), { recursive: true, force: true });
      removed.push(name);
    } catch {}
  }
  return removed;
}

// 入れ子の実行（隔離済みの TMPDIR の下で更に bun test を起動する場合）でも、それぞれ自分の隔離先を持つ。
if (!process.env.NOD_TEST_TMPDIR_DISABLE) {
  const base = tmpdir();
  sweepStale(base);
  const dir = mkdtempSync(join(base, `${RUN_PREFIX}${process.pid}-`));
  process.env.TMPDIR = dir;
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  // bun test は終了時に process の "exit" を発火しないため、preload の afterAll（全ファイルの後に1回）で消す。
  afterAll(cleanup);
  process.on("exit", cleanup);
  for (const [sig, num] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(128 + num);
    });
  }
}
