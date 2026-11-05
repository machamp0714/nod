import type { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repairReviewOnce } from "./review-repair";
import { reviewSourceFingerprint, type ReviewPreparation } from "./review-prepare";
import { captureLocalReview } from "./review-snapshot";
import { ReviewFailure, reviewProcess } from "./review-process";
import type { ReviewExecution, RunReviewInput } from "./review-run";

export interface AutoRepairResult {
  status: "incomplete" | "patch_ready" | "not_needed";
  application: "not_applied";
  applied: false;
  iterations: number;
  maxIterations: 3;
  patchPath: string;
  patchTarget: ReviewExecution["target"];
  checks?: { verificationCompleted: boolean; reviewsPassed: boolean; requirementsUnchanged: boolean; originalTargetUnchanged: boolean };
  history: { iteration: number; resultPath: string; reviewPath?: string; target: ReviewExecution["target"] }[];
}

export async function autoRepairReview(db: Database, input: RunReviewInput, initial: ReviewExecution,
  review: (db: Database, input: RunReviewInput, fixed: ReviewPreparation) => Promise<ReviewExecution>): Promise<ReviewExecution> {
  const directory = dirname(initial.artifactPath);
  const autoRepair: AutoRepairResult = { status: "incomplete", application: "not_applied", applied: false, iterations: 0, maxIterations: 3,
    patchPath: join(directory, "changes.patch"), patchTarget: initial.target, history: [] };
  writeFileSync(autoRepair.patchPath, "", { flag: "wx" });
  let result = initial;
  const deadline = Date.parse(initial.execution.deadline);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort); process.on("SIGTERM", abort); process.on("SIGHUP", abort);
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) controller.abort();
  const check = () => {
    if (controller.signal.aborted) throw new ReviewFailure("CANCELLED", "自動修正が中断されました");
    if (Date.now() >= deadline) throw new ReviewFailure("DEADLINE_EXCEEDED", "初回準備からの全体期限に到達しました");
    if (reviewSourceFingerprint(db, initial as unknown as ReviewPreparation) !== initial.execution.sourceFingerprint) throw new ReviewFailure("REQUIREMENTS_CHANGED", "初回の要求・計画・規約が変更されました。新しい実行が必要です");
  };
  try {
    if (input.repairOnce) throw new ReviewFailure("REPAIR_MODE_CONFLICT", "--auto-repairと--repair-onceは併用できません");
    if (initial.status !== "completed") return result;
    check();
    let current = initial;
    if (!(current.findings ?? []).some(f => f.decision === "required")) {
      autoRepair.status = "not_needed";
      return result;
    }
    // 利用者の計画を反復ごとに再読込せず、この実行用に固定する。
    const planPath = input.repairPlan ? join(directory, "repair-plan.json") : undefined;
    if (planPath) writeFileSync(planPath, readFileSync(input.repairPlan!), { flag: "wx" });
    const causes = (r: ReviewExecution) => new Set((r.findings ?? []).filter(f => f.decision === "required").map(f => String(f.rootCause)));
    const seenCauses = causes(current);
    const seenTrees = new Set<string>();
    const priorConfirmedFindings: Record<string, unknown>[] = [];
    for (let iteration = 1; iteration <= 3; iteration++) {
      check();
      priorConfirmedFindings.push(...(current.findings ?? []).filter(f => f.decision === "required"));
      result = await repairReviewOnce(db, { ...input, signal: controller.signal, repairPlan: planPath, priorConfirmedFindings }, current, review, iteration, initial);
      autoRepair.iterations = iteration;
      autoRepair.history.push({ iteration, resultPath: result.artifactPath, reviewPath: result.repair?.reviewPath, target: result.repair?.finalTarget ?? result.target });
      if (result.repair?.cumulativePatchPath) {
        try { copyFileSync(result.repair.cumulativePatchPath, autoRepair.patchPath); }
        catch { throw new ReviewFailure("PATCH_SAVE_FAILED", "累積patchを受け渡し先へ保存できません。各回のcumulative.patchと履歴を確認してください"); }
        autoRepair.patchTarget = result.repair.finalTarget ?? result.target;
        const tree = autoRepair.patchTarget?.local?.treeSha;
        if (!readFileSync(autoRepair.patchPath).length || (tree && seenTrees.has(tree))) throw new ReviewFailure("REPAIR_NO_PROGRESS", "修正後の内容が初回または過去の対象treeへ戻りました。循環を停止します");
        if (tree) seenTrees.add(tree);
      }
      check();
      if (result.repair?.status === "ready") {
        autoRepair.checks = { verificationCompleted: result.repair.commands.some(c => c.phase === "verify") && result.repair.commands.every(c => c.status === "completed"),
          reviewsPassed: result.status === "completed" && result.score === 5 && result.review.standards === "passed" && result.review.spec === "passed",
          requirementsUnchanged: true, originalTargetUnchanged: false };
        if (!autoRepair.checks.verificationCompleted || !autoRepair.checks.reviewsPassed) throw new ReviewFailure("REREVIEW_INCOMPLETE", "必要な検証と両軸5点が完了していません");
        const target = initial.target!;
        const git = async (...args: string[]) => (await reviewProcess("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", target.repo, ...args], { cwd: directory, deadline, signal: controller.signal })).stdout;
        const applicationCheck = join(directory, "application-check");
        mkdirSync(applicationCheck);
        try {
          // commit対象は不変なので、作業ツリーの無関係な編集で止めず、固定commitが残ることだけ確かめる。
          const currentTarget = target.local ? await captureLocalReview({ repo: target.repo, directory: applicationCheck, headSha: target.headSha, untracked: target.local.untracked ?? [], git, deadline, signal: controller.signal }) : null;
          if (!target.local) await git("rev-parse", "--verify", `${target.headSha}^{commit}`);
          if (target.local && (currentTarget!.treeSha !== target.local.treeSha || currentTarget!.indexHash !== target.local.indexHash || currentTarget!.sourceFingerprint !== target.local.sourceFingerprint)) throw new ReviewFailure("ORIGINAL_TARGET_CHANGED", "元のHEAD・index・対象ファイルが開始時の版と一致しません。新しい実行が必要です");
        } catch (error) {
          if (error instanceof ReviewFailure && ["DEADLINE_EXCEEDED", "CANCELLED"].includes(error.code)) throw error;
          throw new ReviewFailure("ORIGINAL_TARGET_CHANGED", "元の対象が開始時と一致することを確認できません。利用者の変更を保持して停止します");
        }
        check();
        autoRepair.checks.originalTargetUnchanged = true;
        // 完了と点数は隔離修正後の固定対象だけに対応する。元作業へは反映しない。
        autoRepair.status = "patch_ready";
        break;
      }
      // その版のレビュー自体が完了した退行だけを次の修正へ渡す。
      if (!result.repair?.reviewPath || result.problems.some(p => p.code !== "REREVIEW_INCOMPLETE")) break;
      const reviewed = JSON.parse(readFileSync(result.repair.reviewPath, "utf8")) as ReviewExecution;
      if (reviewed.status !== "completed" || reviewed.score === null) break;
      const nextCauses = causes(reviewed);
      if ([...nextCauses].some(cause => seenCauses.has(cause))) throw new ReviewFailure("REPAIR_CAUSE_RECURRED", "同じ根本原因が再レビューで確認されました。再修正せず成果と残件を保持します");
      if (nextCauses.size >= causes(current).size || reviewed.score < current.score!) throw new ReviewFailure("REPAIR_NO_PROGRESS", "要対応の根本原因数が減らないか、最重影響が悪化しています。進展なしとして停止します");
      for (const cause of nextCauses) seenCauses.add(cause);
      if (iteration === 3) throw new ReviewFailure("REPAIR_ITERATION_LIMIT", "修正・再レビューの最大3回に達しました。残る要対応と最終版を保持します");
      current = reviewed;
    }
  } catch (error) {
    const problem = { code: error instanceof ReviewFailure ? error.code : "AUTO_REPAIR_FAILED", message: error instanceof ReviewFailure ? error.message : "自動修正の継続に失敗しました。保存済みのpatchと履歴を確認してください" };
    result = { ...result, status: "incomplete", score: null, problems: [...result.problems, problem] };
  } finally {
    controller.abort();
    process.off("SIGINT", abort); process.off("SIGTERM", abort); process.off("SIGHUP", abort);
    input.signal?.removeEventListener("abort", abort);
    result.autoRepair = autoRepair;
    result.artifactPath = join(directory, "result.json");
    result.execution = { ...result.execution, deadline: initial.execution.deadline, elapsedMs: Date.now() - Date.parse(initial.startedAt) };
    result.remaining = [...new Set([...result.remaining, ...result.problems.map(p => p.message)])];
    writeFileSync(result.artifactPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  }
  return result;
}
