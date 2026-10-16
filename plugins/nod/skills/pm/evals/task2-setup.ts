import { writeEvaluationEnv } from "./shell-env";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, setAutomationSettings } from "../../../../../packages/core/src";
import { createTask1Scenario } from "./setup";

export type Task2Variant = "normal" | "model-mismatch" | "model-unknown" | "unsupported" | "test-failure" | "evidence-missing" | "existing-pr";
export const task2Variants: Task2Variant[] = ["normal", "model-mismatch", "model-unknown", "unsupported", "test-failure", "evidence-missing", "existing-pr"];

/** PMの判断を代行せず、workerとGitHubの外部状態だけを再現する。 */
export async function createTask2Scenario(options: { directory?: string; variant?: Task2Variant; prReview?: boolean } = {}) {
  const scenario = await createTask1Scenario(options.directory);
  const db = openDb(scenario.dbPath);
  setAutomationSettings({ db, actor: "me" }, "API", { prReview: options.prReview ?? true });
  db.close();
  writeFileSync(join(scenario.dir, "task2-state.json"), JSON.stringify({
    variant: options.variant ?? "normal", run: null, tasks: [], workers: [], sent: [], delivery: null,
    pr: options.variant === "existing-pr" ? {
      number: 42, url: "https://github.com/evaluation/api/pull/42", title: "一覧の余白を調整", state: "OPEN", isDraft: false,
      headRefName: "list-spacing", baseRefName: "main", headRefOid: "0".repeat(40), baseRefOid: "b".repeat(40),
      reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [], mergedAt: null,
    } : null,
  }));
  // Orcaのdiscovery stubが実機の実行ファイルへ進まないよう、偽CLIを明示する。
  scenario.env.ORCA_CLI_COMMAND = scenario.orca;
  writeEvaluationEnv(scenario.dir, { ORCA_CLI_COMMAND: scenario.orca }, true);
  return scenario;
}

if (import.meta.main) {
  const variant = process.argv[3] ?? "normal";
  if (!task2Variants.includes(variant as Task2Variant)) throw new Error(`未対応の評価シナリオ: ${variant}`);
  const scenario = await createTask2Scenario({ directory: process.argv[2], variant: variant as Task2Variant, prReview: process.argv[4] !== "off" });
  console.log(JSON.stringify({ directory: scenario.dir, source: join(scenario.dir, "env.sh"), operations: scenario.log }, null, 2));
}
