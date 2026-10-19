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

test("複数起票の評価では2件目だけ本文更新が失敗し、ほかのIssueと再取得を保つ", () => {
  const root = tempDir("nod-backlog-partial-");
  expect(Bun.spawnSync([process.execPath, setup, root]).exitCode).toBe(0);
  const run = (args: string[], expectedCode = 0) => {
    const result = Bun.spawnSync([join(root, "10/bin/nod"), ...args]);
    expect(result.exitCode).toBe(expectedCode);
    return JSON.parse(result.stdout.toString());
  };
  for (let i = 1; i <= 3; i++) {
    run(["issue", "create", `機能${i}`, "--template", "機能改善", "--requested", "--json"]);
  }
  run(["issue", "update", "EVAL-1", "-d", "反映済みの本文1", "--json"]);
  expect(run(["--json", "-wEVAL", "issue", "update", "EVAL-2", "-d", "未反映の本文"], 1).error.code).toBe("DB_BUSY");
  expect(run(["issue", "update", "--json", "EVAL-2", "-d", "未反映の本文"], 1).error.code).toBe("DB_BUSY");
  run(["issue", "update", "EVAL-3", "-d", "反映済みの本文3", "--json"]);
  expect(run(["issue", "list", "--json"])).toHaveLength(3);
  expect(run(["issue", "show", "EVAL-1", "--json"]).description).toBe("反映済みの本文1");
  expect(run(["issue", "show", "EVAL-2", "--json"]).description).toContain("［対象者と場面］");
  expect(run(["issue", "show", "EVAL-3", "--json"]).description).toBe("反映済みの本文3");
});

test("複数起票の応答喪失では2件目が保存され、照合後の次の作成は成功する", () => {
  const root = tempDir("nod-backlog-response-");
  expect(Bun.spawnSync([process.execPath, setup, root]).exitCode).toBe(0);
  // ヘルプ表示は保存を伴わず、応答喪失の対象件数に数えない。
  expect(Bun.spawnSync([join(root, "11/bin/nod"), "issue", "create", "--help"]).exitCode).toBe(0);
  expect(Bun.spawnSync([join(root, "11/bin/nod"), "issue", "create", "-h"]).exitCode).toBe(0);
  const run = (args: string[], expectedCode = 0) => {
    const result = Bun.spawnSync([join(root, "11/bin/nod"), ...args]);
    expect(result.exitCode).toBe(expectedCode);
    return JSON.parse(result.stdout.toString());
  };
  expect(run(["issue", "--json", "create", "機能1", "-d", "本文1", "--requested"]).id).toBe("EVAL-1");
  expect(run(["issue", "--workspace=EVAL", "--json", "create", "機能2", "-d", "本文2", "--requested"], 1).error.code).toBe("CONNECTION_LOST");
  expect(run(["issue", "list", "--json"])).toHaveLength(2);
  expect(run(["issue", "show", "EVAL-2", "--json"]).description).toBe("本文2");
  expect(run(["issue", "create", "機能3", "-d", "本文3", "--requested", "--json"]).id).toBe("EVAL-3");
  expect(run(["issue", "list", "--json"])).toHaveLength(3);
  const log = readFileSync(join(root, "11/operations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(log.filter((entry) => entry.fault === "response-lost")).toHaveLength(1);
});
