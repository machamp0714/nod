import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { GUIDE } from "../src/guide";

describe("手引き", () => {
  test("着手を拒まれたときのエラーコードへの対処を書く", () => {
    for (const code of ["ASSIGNED_TO_OTHER", "AWAITING_ANSWER", "BLOCKED"]) {
      expect(GUIDE).toMatch(new RegExp(`^- ${code}：`, "m"));
    }
  });

  test("差し戻されたら in_progress のまま、理由を読んで nod issue start で再開すると書く", () => {
    const line = GUIDE.split("\n").find((l) => l.includes("差し戻"));
    expect(line).toBeDefined();
    expect(line).toContain("in_progress");
    expect(line).toContain("nod issue show <id>");
    expect(line).toContain("nod issue start <id>");
  });
});

describe("main.ts", () => {
  test("実行できるファイルで、先頭に bun の shebang がある", async () => {
    const main = join(import.meta.dir, "../src/main.ts");
    expect(statSync(main).mode & 0o111).not.toBe(0);
    expect((await Bun.file(main).text()).startsWith("#!/usr/bin/env bun\n")).toBe(true);
    const staged = Bun.spawnSync(["git", "ls-files", "-s", "src/main.ts"], { cwd: join(import.meta.dir, "..") });
    expect(staged.stdout.toString()).toStartWith("100755");
  });
});
