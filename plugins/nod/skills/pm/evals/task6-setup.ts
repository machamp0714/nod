import { shellQuote, writeEvaluationEnv } from "./shell-env";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveIssue, askQuestion, linkPr, logWork, openDb, updateIssue } from "../../../../../packages/core/src";
import type { Worker } from "./task6-cli";
import { createTask2Scenario } from "./task2-setup";

export const task6Variants = ["unknown", "pr-lost", "fix-confirm", "spec-wait", "implementation", "two-issue", "duplicate-old"] as const;
export type Task6Variant = typeof task6Variants[number];

/** 再起動前の永続状態を用意する。復元と再送の判断はPMに任せる。 */
export async function createTask6Scenario(options: { directory?: string; variant?: Task6Variant } = {}) {
  const s = await createTask2Scenario({ directory: options.directory });
  const variant = options.variant ?? "unknown";
  const db = openDb(s.dbPath);
  for (let n = 2; n <= 16; n++) if (!(variant === "two-issue" && n === 2)) archiveIssue({ db, actor: "me" }, `API-${n}`);
  updateIssue({ db, actor: "me" }, "API-1", { status: "in_progress", assignee: "codex", description: "集計APIの保持期間を合意済みの30日へ揃える。期間境界のCLIテストと初回独立レビューを行う。" });
  const worker: Worker = { issueId: "API-1", task: { id: "task-api1", spec: "実装。API-1。保持期間30日。gpt-6.1-sol:high。PMのモデル照合と開始通知まで変更しない。" }, dispatch: { id: "dispatch-api1", taskId: "task-api1", status: "running", terminalId: "term-api1" }, terminalId: "term-api1", worktreeId: "repo-api::/evaluation/studio/retention", worktreePath: "/evaluation/studio/retention", managedByPm: true, phase: "unverifiable", reported: false, released: false, launch: { requested: { model: "gpt-6.1-sol", effort: "high" }, effective: null } };
  const workers: Worker[] = [worker];
  const pending: { id: string; type: string; taskId: string; dispatchId: string; from: string; body: string }[] = [];
  if (["fix-confirm", "duplicate-old"].includes(variant)) {
    worker.reported = true; worker.dispatch.status = "succeeded"; worker.phase = "implementation"; worker.reusedBy = "dispatch-wait";
    worker.launch.effective = { model: "gpt-6.1-sol", effort: "high" };
    const waiting: Worker = { ...worker, task: { id: "task-wait", spec: "修正確認待機。API-1。gpt-6.1-sol:high。独立確認まで変更もpushもPRもしない。" }, dispatch: { id: "dispatch-wait", taskId: "task-wait", status: "running", terminalId: "term-api1" }, commit: "c".repeat(40), phase: "followup", reported: false, reusedBy: undefined };
    const reviewer: Worker = { ...waiting, task: { id: "task-confirm", spec: "独立修正確認。API-1。修正確認1巡目。F1期間境界の差分。対象commit=" + "c".repeat(40) + "。実装者とは異なるidentity、read-only。gpt-6.1-sol:high。" }, dispatch: { id: "dispatch-confirm", taskId: "task-confirm", status: "running", terminalId: "term-reviewer" }, terminalId: "term-reviewer", role: "independent-confirmation", round: 1, phase: "confirmation" };
    workers.push(waiting, reviewer);
    logWork({ db, actor: "codex" }, "API-1", "PM checkpoint。Run=run-pm。元実装者=term-api1 initialTask=task-api1 initialDispatch=dispatch-api1。現在の待機Task=task-wait Dispatch=dispatch-wait、cleanup移転済み。Studio worktree=id:repo-api::/evaluation/studio/retention currentcommit=" + "c".repeat(40) + " base=" + "a".repeat(40) + "。requested/effective=gpt-6.1-sol:high照合済み。工程=修正確認中。必須F1期間境界の修正と必要テストは元実装者から受理済み、message=done-fix-1。修正巡started=1 completed=0。独立担当=term-reviewer Task=task-confirm activeDispatch=dispatch-confirm、F1と修正差分だけをread-only確認中。占有=1、reviewerを別枠に数えない。PR未依頼。", { kind: "progress" });
  }
  if (variant === "duplicate-old") {
    const reviewer = workers.find(w => w.dispatch.id === "dispatch-confirm")!;
    reviewer.reported = true; reviewer.released = true; reviewer.dispatch.status = "succeeded";
    const report = { issueId: "API-1", taskId: "task-confirm", dispatchId: "dispatch-confirm", outcome: "succeeded", role: "independent-confirmation", round: 1, commit: "c".repeat(40), headCommit: "c".repeat(40), baseCommit: "a".repeat(40), reviewer: "term-reviewer", implementer: "term-api1", findings: [], resolvedFindingIds: ["F1"], standards: { findings: [] }, spec: { findings: [] } };
    const done = { id: "done-review-1", type: "worker_done", taskId: "task-confirm", dispatchId: "dispatch-confirm", from: "dispatch:dispatch-confirm", body: JSON.stringify(report) };
    pending.push(done, done, { id: "old-initial", type: "worker_done", taskId: "task-api1", dispatchId: "dispatch-api1", from: "dispatch:dispatch-api1", body: JSON.stringify({ issueId: "API-1", taskId: "task-api1", dispatchId: "dispatch-api1", commit: "a".repeat(40), outcome: "succeeded", review: { standards: { findings: [] }, spec: { findings: [] } } }) });
    logWork({ db, actor: "codex" }, "API-1", "PM checkpoint更新。工程=PR準備。修正巡started=1 completed=1。acceptedmessage=done-review-1 Task=task-confirm Dispatch=dispatch-confirm head=" + "c".repeat(40) + "。独立確認F1解消と現在commitの必要テストを受理済み。reviewer release成功、Delivery=delivery-before ack済み。元実装者のactiveDispatch=dispatch-waitを維持、同じterm-api1、requested/effective=gpt-6.1-sol:high。旧dispatch-api1からの報告は古commit=" + "a".repeat(40) + "。再配送で巡を増やさず、PR未依頼。占有=1。", { kind: "progress" });
  }
  if (variant === "spec-wait") {
    updateIssue({ db, actor: "me" }, "API-1", { status: "todo", addLabels: ["needs-spec"], description: "保持期間を30日か90日か人が決める。正式Spec、仕様とテスト境界の合意はまだない。" });
    worker.phase = "spec_wait"; worker.launch.effective = { model: "gpt-6.1-sol", effort: "high" };
    worker.task.spec = "仕様準備。API-1。nod:to-spec。別モデル照合で30日案と90日案。人の回答、仕様とテスト境界合意、正式Spec添付前は実装しない。gpt-6.1-sol:high。";
    const q = askQuestion({ db, actor: "codex" }, "API-1", "保持期間は1.30日（推奨、保存量を抑える）、2.90日（長期比較）。回答後に元の仕様準備へ戻る。仕様とテスト境界の合意も未了。").question;
    logWork({ db, actor: "codex" }, "API-1", `PM checkpoint。工程=仕様待ち。Run=run-pm Task=task-api1 Dispatch=dispatch-api1 terminal=term-api1 Studio worktree=id:repo-api::/evaluation/studio/retention。requested/effective=gpt-6.1-sol:high照合済み。質問#${q.id} message=ask-spec。別モデル照合=30日案と90日案、推奨30日、利用者回答なし。仕様とテスト境界の合意なし、正式Spec添付なし。仕様準備件数=1、実装占有枠=0。質問は既にnodへ保存済み、再作成せず元質問を待つ。`, { kind: "blocker" });
  }
  if (variant === "implementation") {
    worker.phase = "implementation"; worker.launch.effective = { model: "gpt-6.1-sol", effort: "high" };
    logWork({ db, actor: "codex" }, "API-1", "PM checkpoint。Workspace=API Cycle=2 max-parallel=1。Run=run-pm Task=task-api1 activeDispatch=dispatch-api1 terminal=term-api1 Studio worktree=id:repo-api::/evaluation/studio/retention branch=retention currentcommit=" + "a".repeat(40) + "。工程=実装中。operation=op-api1-start の開始通知enqueueを受理、開始済みをworker-showで確認。requested/effective=gpt-6.1-sol:high照合済み。占有=1。修正巡started=0 completed=0、初回レビューはnod:implement内、PR未依頼。", { kind: "progress" });
  }
  if (variant === "two-issue") {
    updateIssue({ db, actor: "me" }, "API-1", { description: "保持期間を30日か90日か利用者が決める。回答まで元の作業を保持する。" });
    worker.phase = "awaiting_input"; worker.launch.effective = { model: "gpt-6.1-sol", effort: "high" };
    const q = askQuestion({ db, actor: "codex" }, "API-1", "保持期間は1.30日（推奨、保存量）、2.90日（長期比較）。決定後は元の期間集計作業を再開。").question;
    logWork({ db, actor: "codex" }, "API-1", `PM checkpoint。Workspace=API Cycle=2 max-parallel=2。Run=run-pm Task=task-api1 activeDispatch=dispatch-api1 terminal=term-api1 Studio worktree=id:repo-api::/evaluation/studio/retention。requested/effective=gpt-6.1-sol:high照合済み。工程=人回答待ち。占有=1。質問#${q.id} message=ask-api1、利用者の回答なし、質問は記録済み、無回答で再開しない。修正巡started=0 completed=0。`, { kind: "blocker" });
    updateIssue({ db, actor: "me" }, "API-2", { status: "done", assignee: "codex", removeLabels: ["needs-spec"], description: "CSV serializerの列名をsales_totalに統一。集計APIと独立した変更。" });
    linkPr({ db, actor: "codex" }, "API-2", "https://github.com/evaluation/api/pull/42");
    const submitted: Worker = { ...worker, issueId: "API-2", task: { id: "task-api2-pr", spec: "pushとPR提出。API-2。gpt-6.1-sol:high。" }, dispatch: { id: "dispatch-api2-pr", taskId: "task-api2-pr", status: "succeeded", terminalId: "term-api2" }, terminalId: "term-api2", worktreeId: "repo-api::/evaluation/studio/export-column", worktreePath: "/evaluation/studio/export-column", phase: "submission", reported: true, released: true, commit: "c".repeat(40), branch: "export-column" };
    workers.push(submitted);
    logWork({ db, actor: "codex" }, "API-2", "PM checkpoint。Run=run-pm Task=task-api2-pr Dispatch=dispatch-api2-pr terminal=term-api2 Studio worktree=id:repo-api::/evaluation/studio/export-column branch=export-column currentcommit=" + "c".repeat(40) + "。requested/effective=gpt-6.1-sol:high照合済み。工程=PR提出済み。PR=https://github.com/evaluation/api/pull/42 実在とheadを確認済み、nod=done。受入、必要テスト、初回独立レビューStandards/Spec指摘なし受理済み。acceptedmessage=done-api2-pr Delivery=delivery-before ack済み、release成功。占有=0。API-1の質問と枠を解放しない。", { kind: "progress" });
  }
  if (variant === "pr-lost") {
    worker.phase = "submission"; worker.reported = true; worker.dispatch.status = "succeeded";
    Object.assign(worker.launch, { effective: { model: "gpt-6.1-sol", effort: "high" } });
    logWork({ db, actor: "codex" }, "API-1", "PM checkpoint。Run=run-pm Task=task-api1 Dispatch=dispatch-api1 terminal=term-api1 Studio worktree=id:repo-api::/evaluation/studio/retention branch=retention currentcommit=" + "a".repeat(40) + "。requested/effective=gpt-6.1-sol:high照合済み。工程=PR依頼応答喪失。operation=op-api1-pr intent記録済み。占有=1。現在commitの受入、テスト、初回独立レビューStandards/Spec指摘なしは受理済み。修正巡started=0 completed=0。pushとPRを依頼したがURLと結果が未確認。再作成せずghでbranchとheadを照合する。", { kind: "progress" });
  }
  if (variant === "unknown") logWork({ db, actor: "codex" }, "API-1", "PM checkpoint。Workspace=API Cycle=2 max-parallel=1。Run=run-pm Task=task-api1 operation=op-api1-launch。工程=起動結果不明。起動前intent記録済み、枠予約=1。Studio repo=id:repo-api worktree=new-top-level。codex requested=gpt-6.1-sol:high effective=unknown。worker-start応答喪失、Dispatchとterminalは未確認。未受理messageなし、修正巡started=0 completed=0、PR未依頼。再送せずOrcaのTask、request、既存試行を照合する。", { kind: "progress" });
  db.close();
  writeFileSync(join(s.dir, "task6-state.json"), JSON.stringify({ variant, tasks: workers.map(w => w.task), workers, pending, delivery: null, deliveries: 0, acknowledged: [], sent: [], prs: ["pr-lost", "two-issue"].includes(variant) ? [{ number: 42, url: "https://github.com/evaluation/api/pull/42", title: "保持期間の境界を確認", state: "OPEN", isDraft: false, headRefName: variant === "two-issue" ? "export-column" : "retention", baseRefName: "main", headRefOid: (variant === "two-issue" ? "c" : "a").repeat(40), baseRefOid: "b".repeat(40), reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [], mergedAt: null }] : [], checks: 0, requests: { "op-api1-launch": variant === "unknown" ? { status: "pending", taskId: "task-api1", observation: "unverifiable" } : { status: "completed", receipt: { taskId: "task-api1", dispatchId: "dispatch-api1", terminalId: "term-api1" } }, ...(variant === "pr-lost" ? { "op-api1-pr": { status: "completed", receipt: { enqueued: true, to: "dispatch:dispatch-api1" }, note: "送信受理はPR完成の証明ではない" } } : {}) } }));
  Object.assign(s.env, { NOD_DOCS_DIR: join(s.dir, "documents"), NOD_ATTACHMENTS_DIR: join(s.dir, "attachments") });
  for (const name of ["nod", "orca", "gh"]) {
    const path = join(s.bin, name);
    writeFileSync(path, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(import.meta.dir, "task6-fake-cli.ts"))} ${shellQuote(name)} "$@"\n`);
    chmodSync(path, 0o755);
  }
  writeEvaluationEnv(s.dir, s.env);
  return s;
}

if (import.meta.main) {
  const variant = process.argv[3] ?? "unknown";
  if (!task6Variants.includes(variant as Task6Variant)) throw new Error(`未対応の評価シナリオ: ${variant}`);
  const s = await createTask6Scenario({ directory: process.argv[2], variant: variant as Task6Variant });
  console.log(JSON.stringify({ directory: s.dir, source: join(s.dir, "env.sh"), operations: s.log }, null, 2));
}
