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

test("Triageの3操作は人に依頼し、権限エラーで回避しないと案内する", () => {
  expect(GUIDE).toContain("nod triage accept");
  expect(GUIDE).toContain("nod triage decline");
  expect(GUIDE).toContain("nod triage duplicate");
  expect(GUIDE).toContain("nod triage propose <id>");
  expect(GUIDE).toContain("nod triage proposals <id>");
  expect(GUIDE).toContain("nod triage propose <id> --withdraw");
  expect(GUIDE).toContain("FORBIDDEN_FOR_LLM：");
  expect(GUIDE).toContain("人に判断を依頼");
  expect(GUIDE).toContain("nod project update");
  expect(GUIDE).toContain("--completion-candidates");
  expect(GUIDE).toContain("完了候補の親を done にするのは人である");
});
