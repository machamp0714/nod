import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers";

const setup = join(import.meta.dir, "../../../plugins/nod/evals/backlog/setup.ts");

test("バックログ評価の障害注入はグローバルオプションの位置と表記によらない", () => {
  const root = tempDir("nod-backlog-options-");
  const created = Bun.spawnSync([process.execPath, setup, root]);
  expect(created.exitCode).toBe(0);
  const run = (scenario: string, args: string[], expectedCode = 0) => {
    const result = Bun.spawnSync([join(root, scenario, "bin/nod"), ...args]);
    expect(result.exitCode).toBe(expectedCode);
    return JSON.parse(result.stdout.toString());
  };
  const issue = run("06", ["issue", "create", "本文更新の評価", "--template", "機能改善", "--requested", "--json"]);
  const original = issue.description;
  const options = [
    [], ["--json"], ["--json", "-w", "EVAL"], ["-w", "EVAL", "--json"],
    ["--workspace", "EVAL", "--json"], ["--json", "--workspace=EVAL"],
    ["--json", "-wEVAL"],
  ];
  for (const prefix of options) {
    expect(run("04", [...prefix, "template", "list", "--json"], 1).error.code).toBe("DB_BUSY");
    expect(run("06", [...prefix, "issue", "update", issue.id, "-d", "未反映の本文", "--json"], 1).error.code).toBe("DB_BUSY");
  }
  expect(run("06", ["--json", "issue", "show", issue.id]).description).toBe(original);
  expect(run("06", ["--json", "issue", "list"])).toHaveLength(1);
  expect(run("01", ["--json", "template", "list"])).toEqual([]);
  const log = readFileSync(join(root, "06/operations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(log.filter((entry) => entry.args.includes("update"))).toHaveLength(options.length);
});
