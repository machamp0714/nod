import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_PREFIX, sweepStale } from "./tmpdir-preload";

describe("tmpdir-preload（#147）", () => {
  test("bun test 中の tmpdir() は実行ごとの隔離ディレクトリを指す", () => {
    expect(tmpdir()).toContain(`${RUN_PREFIX}${process.pid}-`);
  });

  test("持ち主のプロセスが居ない隔離先だけを回収し、他の nod-* には触れない", () => {
    const base = mkdtempSync(join(tmpdir(), "sweep-"));
    const dead = join(base, `${RUN_PREFIX}999999-abc`); // 存在しない pid
    const mine = join(base, `${RUN_PREFIX}${process.pid}-abc`);
    const parent = join(base, `${RUN_PREFIX}${process.ppid}-abc`); // 生きている別プロセス
    const legacy = join(base, "nod-test-abc");
    for (const d of [dead, mine, parent, legacy]) mkdirSync(join(d, "sub"), { recursive: true });

    expect(sweepStale(base)).toEqual([`${RUN_PREFIX}999999-abc`]);
    expect(existsSync(dead)).toBe(false);
    for (const d of [mine, parent, legacy]) expect(existsSync(d)).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  test("消せない残骸があっても例外にせず、消せたものだけを返す", () => {
    const base = mkdtempSync(join(tmpdir(), "sweep-"));
    const locked = join(base, `${RUN_PREFIX}999998-abc`);
    const dead = join(base, `${RUN_PREFIX}999999-abc`);
    mkdirSync(join(locked, "sub", "file-holder"), { recursive: true });
    mkdirSync(dead, { recursive: true });
    chmodSync(join(locked, "sub"), 0o555);
    try {
      expect(sweepStale(base)).toEqual([`${RUN_PREFIX}999999-abc`]);
      expect(existsSync(locked)).toBe(true);
    } finally {
      chmodSync(join(locked, "sub"), 0o755);
      rmSync(base, { recursive: true, force: true });
    }
  });
});
