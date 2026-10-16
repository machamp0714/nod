import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask1Scenario } from "../../../plugins/nod/skills/pm/evals/setup";
import { createTask2Scenario } from "../../../plugins/nod/skills/pm/evals/task2-setup";
import { createTask3Scenario } from "../../../plugins/nod/skills/pm/evals/task3-setup";
import { createTask4Scenario } from "../../../plugins/nod/skills/pm/evals/task4-setup";
import { createTask5Scenario } from "../../../plugins/nod/skills/pm/evals/task5-setup";
import { createTask6Scenario } from "../../../plugins/nod/skills/pm/evals/task6-setup";

const scenarios = [
  ["Task 1", (directory: string) => createTask1Scenario(directory)],
  ["Task 2", (directory: string) => createTask2Scenario({ directory })],
  ["Task 3", (directory: string) => createTask3Scenario({ directory })],
  ["Task 4", (directory: string) => createTask4Scenario({ directory })],
  ["Task 5", (directory: string) => createTask5Scenario({ directory })],
  ["Task 6", (directory: string) => createTask6Scenario({ directory })],
] as const;

for (const [task, createScenario] of scenarios) {
  for (const shell of ["/bin/sh", "/bin/zsh"]) {
    test.skipIf(!existsSync(shell))(`${task}のenv.shを${shell}でsourceしても特殊文字を展開せず、値と偽CLIを保持する`, async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "nod-pm-shell-")));
      // 展開された場合だけ作られる印を、隔離したcwdの中で観測する。
      const name = "引用'\" 空白 $(touch DOLLAR_MARK) \x60touch BACKTICK_MARK\x60 ; touch SEMICOLON_MARK ; # & | < > \\ 日本語";
      // Task 3の既存Document実パス取得はbackslashに非対応。他の特殊文字でsource境界を検査する。
      const directory = join(root, task === "Task 3" ? name.replace("\\", "") : name);
      try {
        const scenario = await createScenario(directory);
        const source = (command: string) => Bun.spawnSync([
          shell, "-c", '. "$1" || exit\n' + command, "pm-env-test", join(scenario.dir, "env.sh"),
        ], { cwd: root, env: { PATH: process.env.PATH! } });
        const exported = source("exec /usr/bin/env -0");
        expect(exported.exitCode, exported.stderr.toString()).toBe(0);
        const env = Object.fromEntries(exported.stdout.toString().split("\0").filter(Boolean).map(entry => {
          const at = entry.indexOf("=");
          return [entry.slice(0, at), entry.slice(at + 1)];
        }));
        for (const key of ["PATH", "NOD_DB", "NOD_ACTOR", "NOD_ORCA", "NOD_GH", "PM_EVAL_DIR", "PM_EVAL_LOG", "PM_EVAL_BUN", "PM_EVAL_NOD_MAIN", "TYPESAFE_API_KEY", "BUN_OPTIONS", "ORCA_CLI_COMMAND", "NOD_DOCS_DIR", "NOD_ATTACHMENTS_DIR"]) {
          expect(env[key], key).toBe(scenario.env[key]);
        }
        expect(env.NOD_DB).toBe(join(directory, "nod.db"));
        expect(env.NOD_ACTOR).toBe("codex");
        if (task !== "Task 1" && task !== "Task 2") {
          expect(env.NOD_DOCS_DIR).toBe(join(directory, "documents"));
          expect(env.NOD_ATTACHMENTS_DIR).toBe(join(directory, "attachments"));
        }
        const status = source('exec "${ORCA_CLI_COMMAND:-orca}" status --json');
        expect(status.exitCode, status.stderr.toString()).toBe(0);
        expect(JSON.parse(status.stdout.toString())).toMatchObject({ ok: true, result: { environment: "Air" } });
        const issue = source('exec nod -w API issue show API-1 --json');
        expect(issue.exitCode, issue.stderr.toString()).toBe(0);
        expect(JSON.parse(issue.stdout.toString())).toMatchObject({ id: "API-1", workspace: "API" });
        const github = source(task === "Task 4" ? 'exec "$NOD_GH" pr list --json url' : 'exec "$NOD_GH" --help');
        expect(github.exitCode, github.stderr.toString()).toBe(0);
      } finally {
        const executed = ["DOLLAR_MARK", "BACKTICK_MARK", "SEMICOLON_MARK"].filter(marker => existsSync(join(root, marker)));
        rmSync(root, { recursive: true, force: true });
        expect(executed).toEqual([]);
      }
    });
  }
}
