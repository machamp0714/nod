import { shellQuote, writeEvaluationEnv } from "./shell-env";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDocument, logWork, openDb, updateIssue } from "../../../../../packages/core/src";
import { createTask2Scenario } from "./task2-setup";

export const task3Variants = ["technical", "worker-question", "spec-pending", "spec-ready", "human-origin"] as const;
export type Task3Variant = typeof task3Variants[number];

/** 既存実行の外部状態と仕様化済み記録を用意する。人の新しい回答は生成しない。 */
export async function createTask3Scenario(options: { directory?: string; variant?: Task3Variant } = {}) {
  const scenario = await createTask2Scenario({ directory: options.directory });
  const variant = options.variant ?? "worker-question";
  const docsDir = join(scenario.dir, "documents");
  const db = openDb(scenario.dbPath);
  const human = { db, actor: "me" };
  const agent = { db, actor: "codex" };
  updateIssue(human, "API-1", { status: "in_progress", assignee: "codex" });
  updateIssue(human, "API-2", { description: "一覧の売上を営業日別に集計する。営業日の区切りを午前0時か午前5時か、利用者が決める。決まった区切りで集計し、日付境界の合意済みCLIテストで確認する。" });
  logWork(agent, "API-1", "PM管理内。Run=run-existing Task=task-existing Dispatch=dispatch-existing Studio worktree=id:existing-api terminal=term-existing codex gpt-6.1-sol:high。要求値と実効値の照合済み。工程=実装中。", { kind: "progress" });
  const decided = variant === "spec-ready";
  createDocument(agent, { path: "api-2-decisions.md", docsDir, kind: "doc", issueRefs: ["API-2"], title: "API-2 仕様化の決定ログ", body: [
    "nod:to-specの継続記録。Issue本文を前提とする。",
    "独立照合の外部報告（評価シミュレーション）: Codex gpt-6.1-sol:highは午前0時、Claude opusは午前5時を推奨し、利用者判断が必要と一致。根拠は集計の用途による。実機モデルは起動していない。",
    "テスト境界は利用者と合意済み: nod CLIへの日付境界入力と集計結果。再承認不要。",
    decided ? "利用者の実回答（評価fixtureの既存記録）: 午前5時にしてください。仕様と上記テスト境界に合意します。出典=評価用会話 fixture-spec-agreement、決定=午前5時。正式Specは作成、添付済み。ラベル解除を含む最終確認は未実施。" : "未決論点: 営業日の区切り。利用者の回答はまだない。仕様全体の最終合意もまだない。正式Spec未作成。",
  ].join("\n") });
  if (decided) createDocument(agent, { path: "api-2-spec.md", docsDir, kind: "spec", issueRefs: ["API-2"], title: "API-2 正式仕様", body: "Issue本文が前提。nod:to-specで独立照合と利用者の合意を得た。営業日は午前5時から翌午前5時直前までとする。境界前後の入力と集計出力を既存CLI境界で確認する。決定ログ=api-2-decisions.md。" });
  db.close();
  const technical = { id: "ask-technical", type: "question", taskId: "task-existing", dispatchId: "dispatch-existing", from: "dispatch:dispatch-existing", body: "API-1の余白は12pxで確定ですか。Issue本文と同じ値でよいか確認したい。" };
  const decision = { id: "ask-retention", type: "question", taskId: "task-existing", dispatchId: "dispatch-existing", from: "dispatch:dispatch-existing", body: "一覧データの保持期間を30日か90日か利用者に決めてほしい。既存本文、仕様、決定ログに保持期間の決定はない。30日は保存量を減らし、90日は長期比較を可能にする。利用者の判断までこの作業を停止する。" };
  const messages = variant === "worker-question" ? [decision] : variant === "human-origin" ? [] : [technical];
  writeFileSync(join(scenario.dir, "task3-state.json"), JSON.stringify({ variant, pending: messages, replied: [], delivery: null, acknowledged: [], sent: [] }));
  Object.assign(scenario.env, { NOD_DOCS_DIR: docsDir, NOD_ATTACHMENTS_DIR: join(scenario.dir, "attachments") });
  for (const name of ["nod", "orca", "gh"]) {
    const path = join(scenario.bin, name);
    writeFileSync(path, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(import.meta.dir, "task3-fake-cli.ts"))} ${shellQuote(name)} "$@"\n`);
    chmodSync(path, 0o755);
  }
  writeEvaluationEnv(scenario.dir, scenario.env);
  return scenario;
}

if (import.meta.main) {
  const variant = process.argv[3] ?? "worker-question";
  if (!task3Variants.includes(variant as Task3Variant)) throw new Error(`未対応の評価シナリオ: ${variant}`);
  const scenario = await createTask3Scenario({ directory: process.argv[2], variant: variant as Task3Variant });
  console.log(JSON.stringify({ directory: scenario.dir, source: join(scenario.dir, "env.sh"), operations: scenario.log }, null, 2));
}
