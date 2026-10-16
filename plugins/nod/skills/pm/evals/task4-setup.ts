import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logWork, openDb, updateIssue } from "../../../../../packages/core/src";
import { createTask2Scenario } from "./task2-setup";

export const task4Variants = ["one-round", "two-rounds", "unresolved", "stale-commit", "new-defect", "optional-only"] as const;
export type Task4Variant = typeof task4Variants[number];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** 初回レビュー完了後の既存実行だけを用意する。PMの提出判断は行わない。 */
export async function createTask4Scenario(options: { directory?: string; variant?: Task4Variant } = {}) {
  const scenario = await createTask2Scenario({ directory: options.directory });
  const db = openDb(scenario.dbPath);
  updateIssue({ db, actor: "me" }, "API-1", { status: "in_progress", assignee: "codex" });
  logWork({ db, actor: "codex" }, "API-1", "PM管理内。Run=run-pm Task=task-initial Dispatch=dispatch-initial Studio worktree=id:repo-api::/evaluation/studio/list-spacing terminal=term-implementation codex gpt-6.1-sol:high。要求値/実効値は照合済み。工程=初回独立レビュー報告待ち。初回レビューはnod:implement内で実施済み、修正確認0巡。", { kind: "progress" });
  db.close();
  writeFileSync(join(scenario.dir, "task4-state.json"), JSON.stringify({ variant: options.variant ?? "one-round", round: 0, head: "a".repeat(40), tasks: [], workers: [], delivery: null, acknowledged: [], sent: [], pr: null }));
  Object.assign(scenario.env, { NOD_DOCS_DIR: join(scenario.dir, "documents"), NOD_ATTACHMENTS_DIR: join(scenario.dir, "attachments") });
  for (const name of ["nod", "orca", "gh"]) {
    const path = join(scenario.bin, name);
    writeFileSync(path, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, "task4-fake-cli.ts"))} ${quote(name)} "$@"\n`);
    chmodSync(path, 0o755);
  }
  const keys = ["PATH", "NOD_DB", "NOD_ACTOR", "NOD_ORCA", "NOD_GH", "PM_EVAL_DIR", "PM_EVAL_LOG", "PM_EVAL_BUN", "PM_EVAL_NOD_MAIN", "TYPESAFE_API_KEY", "BUN_OPTIONS", "ORCA_CLI_COMMAND", "NOD_DOCS_DIR", "NOD_ATTACHMENTS_DIR"];
  writeFileSync(join(scenario.dir, "env.sh"), Object.entries(scenario.env).filter(([key]) => keys.includes(key)).map(([key, value]) => `export ${key}=${quote(value!)}`).join("\n") + "\n");
  return scenario;
}

if (import.meta.main) {
  const variant = process.argv[3] ?? "one-round";
  if (!task4Variants.includes(variant as Task4Variant)) throw new Error(`未対応の評価シナリオ: ${variant}`);
  const scenario = await createTask4Scenario({ directory: process.argv[2], variant: variant as Task4Variant });
  console.log(JSON.stringify({ directory: scenario.dir, source: join(scenario.dir, "env.sh"), operations: scenario.log }, null, 2));
}
