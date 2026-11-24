import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { runNod, tempDb, tempDir } from "./helpers";

describe("main.ts", () => {
  test("実行できるファイルで、先頭に bun の shebang がある", async () => {
    const main = join(import.meta.dir, "../src/main.ts");
    expect(statSync(main).mode & 0o111).not.toBe(0);
    expect((await Bun.file(main).text()).startsWith("#!/usr/bin/env bun\n")).toBe(true);
    const staged = Bun.spawnSync(["git", "ls-files", "-s", "src/main.ts"], { cwd: join(import.meta.dir, "..") });
    expect(staged.stdout.toString()).toStartWith("100755");
  });
});

test("公開された手引きは書き手共通の操作と確認方法を案内する", async () => {
  const guide = await runNod(["skills", "get", "nod"], { cwd: tempDir(), db: tempDb(), actor: "codex" });
  expect(guide.exitCode).toBe(0);
  expect(guide.stdout).not.toMatch(/FORBIDDEN_FOR_LLM|人だけが行える|LLM は読むだけ/);
  expect(guide.stdout).toMatch(/NOD_ACTOR.*OMPCODE=1.*CLAUDECODE=1.*CODEX_THREAD_ID.*me/);
  for (const command of [
    "nod issue send-instruction <id> <instructionId> --terminal <handle>",
    "nod sprint end <sprint> --input <file|->",
    "nod sprint record add <sprint> --input <file|->",
    "nod notification history",
  ]) expect(guide.stdout).toContain(command);
  expect(guide.stdout).toContain("CONFIRM_REQUIRED");
  expect(guide.stdout).toContain("NOT_INTERACTIVE");
  expect(guide.stdout).toContain("[y/N]");
});
