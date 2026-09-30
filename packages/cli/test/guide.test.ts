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
  expect(GUIDE).toContain("nod project report add");
  expect(GUIDE).toContain("--health on_track|at_risk|off_track");
  expect(GUIDE).toContain("nod project milestone add");
  expect(GUIDE).toContain("--milestone <名前かID>");
  expect(GUIDE).toContain("`remove`（削除）は人だけが行える（LLM は FORBIDDEN_FOR_LLM）");
  expect(GUIDE).toContain("`delete`（削除）は人だけが行える（LLM は FORBIDDEN_FOR_LLM）");
});

test("LLM は nod issue update --status や bulk-update でも Triage の Issue を Triage から出せないと案内する", () => {
  const line = GUIDE.split("\n").find((l) => l.includes("nod issue update --status") && l.includes("Triage から出す"));
  expect(line).toBeDefined();
  expect(line).toContain("nod issue bulk-update");
  expect(line).toContain("FORBIDDEN_FOR_LLM");
});

test("nod の承認は GitHub の承認・マージではなく、nod は GitHub へ書き込まないと案内する（#56/#57）", () => {
  const line = GUIDE.split("\n").find((l) => l.includes("GitHub の承認・マージではない"));
  expect(line).toBeDefined();
  expect(line).toContain("nod review approve");
  expect(GUIDE).toContain("gh pr review");
  expect(GUIDE).toContain("gh pr merge");
});

test("定期Issueで起票された定型作業の扱いを案内する（#64）", () => {
  const section = GUIDE.split("## 定期Issueで起票された定型作業の扱い")[1]?.split("\n## ")[0];
  expect(section).toBeDefined();
  expect(section).toContain("担当に LLM の名前");
  expect(section).toContain("Triage を通らず todo");
  expect(section).toContain("nod issue next");
  expect(section).toContain("recurring_id");
  expect(section).toContain("nod issue done <id>");
  expect(section).toContain("FORBIDDEN_FOR_LLM");
  expect(section).toContain("--discovered-from <id>");
  expect(section).toContain("TRANSITION_NOT_ALLOWED");
  expect(section).toContain("nod template show");
});
