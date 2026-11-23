import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";

describe("main.ts", () => {
  test("実行できるファイルで、先頭に bun の shebang がある", async () => {
    const main = join(import.meta.dir, "../src/main.ts");
    expect(statSync(main).mode & 0o111).not.toBe(0);
    expect((await Bun.file(main).text()).startsWith("#!/usr/bin/env bun\n")).toBe(true);
    const staged = Bun.spawnSync(["git", "ls-files", "-s", "src/main.ts"], { cwd: join(import.meta.dir, "..") });
    expect(staged.stdout.toString()).toStartWith("100755");
  });
});
