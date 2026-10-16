import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveIssue, askQuestion, logWork, openDb, relateIssue, updateIssue } from "../../../../../packages/core/src";
import { createTask2Scenario } from "./task2-setup";

export const task5Variants = ["waiting", "supervise", "idle", "stop", "model-pending", "launch-pending", "unverifiable"] as const;
export type Task5Variant = typeof task5Variants[number];
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** 複数Issueの外部状態を用意する。枠の選択と停止判断はPMが行う。 */
export async function createTask5Scenario(options: { directory?: string; variant?: Task5Variant } = {}) {
  const s = await createTask2Scenario({ directory: options.directory });
  const variant = options.variant ?? "waiting";
  const db = openDb(s.dbPath);
  const human = { db, actor: "me" };
  const agent = { db, actor: "codex" };
  // 評価対象を固定し、Task1の他の候補を混ぜない。
  for (let n = 3; n <= 16; n++) if (![4, 6].includes(n)) archiveIssue(human, `API-${n}`);
  updateIssue(human, "API-1", { status: variant === "idle" ? "todo" : "in_progress", assignee: "codex", description: "保持期間を30日か90日か利用者が決める。集計APIを変更し、期間境界のCLIテストを通す。保持期間の合意はまだない。" });
  if (variant === "supervise") updateIssue(human, "API-1", { description: "集計APIの保持期間30日は利用者と合意済み。期間境界の既存CLIテストを通して実装と初回独立レビューを行う。" });
  updateIssue(human, "API-2", { removeLabels: ["needs-spec"], assignee: null, description: "エクスポートCSVの列名をsales_totalに揃える。対象はCSV serializerだけ。集計APIとファイルが独立している。既存CLIテストで列名を確認する。" });
  updateIssue(human, "API-4", { assignee: null, description: "API-1の期間集計の完了後に集計結果を表示する。未完了依存を外さない。" });
  relateIssue(human, "API-1", { blocks: "API-4" });
  updateIssue(human, "API-6", { status: "todo", addLabels: ["needs-spec"], description: "新しい集計軸の仕様準備。実装はまだ許可されていない。" });
  if (variant === "supervise" || variant === "idle") for (const id of ["API-2", "API-6"]) archiveIssue(human, id);
  if (variant === "idle") askQuestion(human, "API-1", "保持期間を30日か90日か利用者が決める。");
  const phase = variant === "supervise" ? "implementation" : variant === "model-pending" ? "model_pending" : variant === "launch-pending" ? "launching" : variant === "unverifiable" ? "unverifiable" : "awaiting_input";
  const worker = { issueId: "API-1", task: { id: "task-api1", spec: "実装。API-1。期間集計。gpt-6.1-sol:high。" }, dispatch: { id: "dispatch-api1", taskId: "task-api1", status: "running", terminalId: "term-api1" }, terminalId: "term-api1", worktreeId: "repo-api::/evaluation/studio/retention", worktreePath: "/evaluation/studio/retention", managedByPm: true, phase, reported: false, released: false, launch: { requested: { model: "gpt-6.1-sol", effort: "high" }, effective: ["model-pending", "launch-pending", "unverifiable"].includes(variant) ? null : { model: "gpt-6.1-sol", effort: "high" } } };
  if (variant !== "idle") logWork(agent, "API-1", `PM管理内。Run=run-pm Task=task-api1 Dispatch=dispatch-api1 Studio worktree=id:${worker.worktreeId} terminal=term-api1 codex gpt-6.1-sol:high。工程=${phase}。${worker.launch.effective ? "要求値と実効値の照合済み。" : "要求値は記録済み、実効値未照合。開始通知禁止。起動予約を保持。"}`, { kind: "progress" });
  if (variant === "stop") logWork(agent, "API-1", "利用者からの停止指示原文: 新規着手を止めて、既存作業と実行状態を残してください。出典=評価入力 fixture-stop。", { kind: "rationale" });
  db.close();
  const question = { id: "ask-api1", type: "question", taskId: "task-api1", dispatchId: "dispatch-api1", from: "dispatch:dispatch-api1", body: "API-1の保持期間を30日か90日か利用者に決めてほしい。既存本文と決定ログに回答はない。30日は保存量を減らし、90日は長期比較が可能。利用者の回答まで元の作業で待つ。" };
  writeFileSync(join(s.dir, "task5-state.json"), JSON.stringify({ variant, tasks: [], workers: variant === "idle" ? [] : [worker], pending: ["waiting", "stop"].includes(variant) ? [question] : [], delivery: null, deliveries: 0, acknowledged: [], sent: [], prs: [], checks: 0 }));
  Object.assign(s.env, { NOD_DOCS_DIR: join(s.dir, "documents"), NOD_ATTACHMENTS_DIR: join(s.dir, "attachments") });
  for (const name of ["nod", "orca", "gh"]) {
    const path = join(s.bin, name);
    writeFileSync(path, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, "task5-fake-cli.ts"))} ${quote(name)} "$@"\n`);
    chmodSync(path, 0o755);
  }
  const keys = ["PATH", "NOD_DB", "NOD_ACTOR", "NOD_ORCA", "NOD_GH", "PM_EVAL_DIR", "PM_EVAL_LOG", "PM_EVAL_BUN", "PM_EVAL_NOD_MAIN", "TYPESAFE_API_KEY", "BUN_OPTIONS", "ORCA_CLI_COMMAND", "NOD_DOCS_DIR", "NOD_ATTACHMENTS_DIR"];
  writeFileSync(join(s.dir, "env.sh"), Object.entries(s.env).filter(([key]) => keys.includes(key)).map(([key, value]) => `export ${key}=${quote(value!)}`).join("\n") + "\n");
  return s;
}

if (import.meta.main) {
  const variant = process.argv[3] ?? "waiting";
  if (!task5Variants.includes(variant as Task5Variant)) throw new Error(`未対応の評価シナリオ: ${variant}`);
  const s = await createTask5Scenario({ directory: process.argv[2], variant: variant as Task5Variant });
  console.log(JSON.stringify({ directory: s.dir, source: join(s.dir, "env.sh"), operations: s.log }, null, 2));
}
