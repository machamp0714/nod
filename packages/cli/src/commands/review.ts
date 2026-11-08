import { dirname, join } from "node:path";
import {
  checkReviewExploration, checkReviewVerification, freezeReviewEvaluation, planReview, prepareReview, recordReviewExploration, recordReviewVerification, reportReviewEvaluation, reviewInputFiles, showReview,
  type ReviewAgentClaim, type ReviewExplorationInput, type ReviewRecordedStage, type ReviewRunState,
} from "@nod/core";
import { Option, type Command } from "commander";
import { act, actAsync, type Cli } from "../context";
import { print } from "../output";

// JSONはすでに表示済みなので、共通エラー表示で上書きしない。
export class ReviewPreparationIncomplete extends Error {}
const reviewsDir = (cli: Cli) => join(dirname(cli.db.filename), "reviews");
// 準備・計画・探索の記録は点数を持たず、最終の候補検証記録が無い限りレビュー完了ではない。
const stateLabel: Record<ReviewRunState["status"], string> = {
  prepared: "準備のみ・レビュー未完了・点数なし",
  planned: "計画固定済み・レビュー未完了・点数なし",
  explored: "探索のみ・レビュー未完了・点数なし",
  exploration_incomplete: "探索未完了・レビュー未完了・点数なし",
  incomplete: "レビュー未完了・点数なし",
  completed: "レビュー完了",
};
const agentText = (claim?: ReviewAgentClaim) => claim
  ? `${claim.definition}（モデル申告: ${claim.modelClaim.value ?? "未確認"}${claim.modelClaim.source ? `、出典: ${claim.modelClaim.source}` : ""}）` : "未記録";
const stageText = (stage: ReviewRecordedStage) => `${stage.phase}: ${stage.status}（候補 ${stage.output?.candidates.length ?? 0} 件、要求別記録 ${stage.output?.requirements.length ?? 0} 件）${stage.problem ? ` — ${stage.problem.code}: ${stage.problem.message}` : ""}`;
export function registerReviewCommands(program: Command): void {
  const review = program.command("review").description("固定した差分をレビューする");
  const evaluation = review.command("evaluation").description("開発用の過去事例を凍結・集計する");
  evaluation.command("freeze").requiredOption("--manifest <path>", "選定した事例JSON").requiredOption("--out <path>", "新規の凍結ファイル")
    .action(actAsync(async (cli, _cmd, opts: { manifest: string; out: string }) => { const result = freezeReviewEvaluation(opts.manifest, opts.out); print(cli, result, () => `凍結: ${result.cases}事例 ${result.path}`); }));
  evaluation.command("report").requiredOption("--dataset <path>", "凍結した集合").option("--judgments <path>", "人の判定JSON")
    .action(actAsync(async (cli, _cmd, opts: { dataset: string; judgments?: string }) => { const result = reportReviewEvaluation(opts.dataset, opts.judgments); print(cli, result, () => JSON.stringify(result, null, 2)); }));
  review.command("prepare")
    .description("対象・基点・要求・規約を固定し、読取専用snapshotを作る（レビュー未完了・点数なし）")
    .requiredOption("--repo <path>", "対象リポジトリ")
    .requiredOption("--base <ref>", "基点（merge-baseから比較する）")
    .option("--head <ref>", "対象commit", "HEAD")
    .option("--local", "HEAD・index・作業ツリーを固定する")
    .option("--untracked <path>", "含める未追跡ファイル（繰り返し指定）", (value: string, paths: string[]) => [...paths, value], [])
    .option("--issue <id>", "要求を持つIssue")
    .option("--document <idOrPath>", "要求DocumentのIDまたはMarkdownパス")
    .action(actAsync(async (cli, _cmd, opts: { repo: string; base: string; head: string; local?: boolean; untracked?: string[]; issue?: string; document?: string }) => {
      const result = await prepareReview(cli.db, { ...opts, outputDir: reviewsDir(cli) });
      print(cli, result, () => [
        `${result.status === "prepared" ? "準備完了" : "準備未完了"}（${stateLabel[result.status]}）`,
        `実行ID: ${result.runId}`,
        `対象: ${result.target ? `${result.target.mode} ${result.target.mergeBaseSha}...${result.target.headSha} SHA-256=${result.target.hash}` : "取得不能"}`,
        `要求元: ${result.requirements.primary.join(", ") || "未特定"}`,
        `確認対象: ${result.target?.mode ?? "未取得"}差分 ${result.target?.files.length ?? 0} ファイル、資料 ${result.sources.length} 件`,
        ...result.sources.map(s => `資料: ${s.type}:${s.id} 版=${s.version} SHA-256=${s.hash}`),
        ...(result.context && result.status === "prepared" ? [`固定snapshot: ${result.context.path}`] : []),
        ...(result.standardScopeTemplatePath ? [`規約適用計画の雛形: ${result.standardScopeTemplatePath}`] : []),
        ...result.problems.map(p => `${p.code}: ${p.message}`),
        `残件: ${result.remaining.join("、")}`,
        `保存先: ${result.artifactPath}`,
      ].join("\n"));
      if (result.status === "incomplete") throw new ReviewPreparationIncomplete();
    }));
  review.command("plan")
    .description("準備した実行に規約適用計画と責務計画を1回だけ固定し、探索の工程入力を保存する（レビュー未完了）")
    .requiredOption("--run <runId>", "準備の実行ID")
    .option("--scope-plan <path>", "固定規約の適用範囲と根拠のJSON（省略時は全規約を確認）")
    .option("--responsibility-plan <path>", "自動チェック担当の要求と根拠を事前固定したJSON（省略時は分担なし）")
    .action(act((cli, _cmd, opts: { run: string; scopePlan?: string; responsibilityPlan?: string }) => {
      const result = planReview(cli.db, reviewsDir(cli), { runId: opts.run, scopePlan: opts.scopePlan, responsibilityPlan: opts.responsibilityPlan });
      print(cli, result, () => [
        `計画固定（${stateLabel.planned}）`,
        `実行ID: ${result.runId}`,
        `対象: ${result.target.mode} ${result.target.mergeBaseSha}...${result.target.headSha} SHA-256=${result.target.hash}`,
        `規約適用計画: ${result.standardScope ? `SHA-256=${result.standardScope.hash}` : "なし（全規約を確認）"}`,
        `責務計画: ${result.responsibility ? `${result.responsibility.assignments.length} 件 SHA-256=${result.responsibility.hash}` : "なし"}`,
        ...(["standards", "spec"] as const).map(phase => `${phase}入力: ${result.inputs[phase].inputPath}（担当 ${result.inputs[phase].assignedRequirementCount} 単位）`),
        `残件: ${result.remaining.join("、")}`,
        `保存先: ${result.artifactPath}`,
      ].join("\n"));
    }));
  review.command("input")
    .description("固定した工程入力とformat=3のschemaのファイルの場所を返す（本文は出力しない）")
    .requiredOption("--run <runId>", "準備の実行ID")
    .addOption(new Option("--phase <phase>", "工程").choices(["standards", "spec", "verification"]).makeOptionMandatory())
    .action(act((cli, _cmd, opts: { run: string; phase: "standards" | "spec" | "verification" }) => {
      const result = reviewInputFiles(reviewsDir(cli), { runId: opts.run, phase: opts.phase });
      print(cli, result, () => [`入力: ${result.inputPath}`, `schema: ${result.schemaPath}`].join("\n"));
    }));
  review.command("record")
    .description("担当が書いた工程の出力を形式検査して記録する（探索の記録は採点しない）")
    .requiredOption("--run <runId>", "準備の実行ID")
    .addOption(new Option("--phase <phase>", "記録する工程").choices(["exploration", "verification"]).makeOptionMandatory())
    .option("--standards <file>", "Standards探索のformat=3出力JSON")
    .option("--spec <file>", "Spec探索のformat=3出力JSON")
    .option("--output <file>", "候補検証のformat=3出力JSON")
    .requiredOption("--agent <name>", "担当エージェントの定義名")
    .option("--model-claim <text>", "担当が知りうる使用モデルの申告（証明ではない）")
    .option("--model-claim-source <text>", "モデル申告の出典")
    .option("--check", "形式検査だけを行い保存しない")
    .action(actAsync(async (cli, _cmd, opts: { run: string; phase: "exploration" | "verification"; output?: string; standards?: string; spec?: string; agent: string; modelClaim?: string; modelClaimSource?: string; check?: boolean }) => {
      if (opts.phase === "verification") {
        const input = { runId: opts.run, output: opts.output, agent: opts.agent, modelClaim: opts.modelClaim, modelClaimSource: opts.modelClaimSource };
        if (opts.check) {
          const result = checkReviewVerification(reviewsDir(cli), input);
          print(cli, result, () => [`形式検査: ${result.problems.length ? "問題あり" : "問題なし"}（保存していません・点数なし）`, ...result.stages.map(stageText)].join("\n"));
          if (result.problems.length) throw new ReviewPreparationIncomplete();
          return;
        }
        const result = await recordReviewVerification(cli.db, reviewsDir(cli), input);
        print(cli, result, () => [
          `検証記録: ${result.status}（${result.score === null ? "レビュー未完了・点数なし" : `${result.score}/5`}）`,
          `実行ID: ${result.runId}`, `探索担当: ${agentText(result.agents.exploration)}`, `検証担当: ${agentText(result.agents.verification)}`,
          `対象: ${result.target.mode} ${result.target.mergeBaseSha}...${result.target.headSha} SHA-256=${result.target.hash}`,
          `確認範囲: ${result.scope.kind === "limited" ? "限定範囲（Issue全体の充足ではない）" : "固定した要求と規約"}`,
          ...(["standards", "spec"] as const).map(axis => `${axis}: ${result.review[axis]}、要対応 ${result.findings.filter(finding => finding.axis === axis && finding.decision === "required").length} 件`),
          ...result.coverage.map(row => `要求 ${row.id}: ${row.status} — ${row.requirement}`),
          ...result.findings.filter(finding => finding.decision !== "optional").map(finding => `候補 ${finding.axis}:${finding.id}: ${finding.decision} — ${finding.rationale ?? "証拠不足"}`),
          ...(result.fixedResult ? [`固定版の結果: ${result.fixedResult.status}（${result.fixedResult.score === null ? "点数なし" : `${result.fixedResult.score}/5`}）`] : []),
          `現在版への提出: ${result.currentSubmission.eligible ? "固定した確認範囲で可" : "不可"}`,
          ...result.problems.map(problem => `${problem.code}: ${problem.message}`), `保存先: ${result.artifactPath}`,
        ].join("\n"));
        if (result.status !== "completed" || result.score !== 5) throw new ReviewPreparationIncomplete();
        return;
      }
      const input: ReviewExplorationInput = { runId: opts.run, standards: opts.standards, spec: opts.spec, agent: opts.agent, modelClaim: opts.modelClaim, modelClaimSource: opts.modelClaimSource };
      if (opts.check) {
        const result = checkReviewExploration(reviewsDir(cli), input);
        print(cli, result, () => [`形式検査: ${result.problems.length ? "問題あり" : "問題なし"}（保存していません・点数なし）`, ...result.stages.map(stageText)].join("\n"));
        if (result.problems.length) throw new ReviewPreparationIncomplete();
        return;
      }
      const result = recordReviewExploration(reviewsDir(cli), input);
      print(cli, result, () => [
        `探索記録: ${result.status}（${stateLabel[result.status]}）`,
        `実行ID: ${result.runId}`,
        `対象: ${result.target.mode} ${result.target.mergeBaseSha}...${result.target.headSha} SHA-256=${result.target.hash}`,
        ...result.stages.map(stageText),
        `探索担当: ${agentText(result.agents.exploration)}`,
        `残件: ${result.remaining.join("、")}`,
        `保存先: ${result.artifactPath}`,
      ].join("\n"));
      if (result.status !== "explored") throw new ReviewPreparationIncomplete();
    }));
  review.command("show")
    .description("実行の現在の段階・点数・担当の申告・保存先を表示する（記録は変更しない）")
    .requiredOption("--run <runId>", "準備の実行ID")
    .action(act((cli, _cmd, opts: { run: string }) => {
      const result = showReview(reviewsDir(cli), opts.run);
      print(cli, result, () => [
        `状態: ${result.status}（${result.status === "completed" ? `${stateLabel.completed}・${result.score === null ? "点数なし" : `${result.score}/5`}` : stateLabel[result.status]}）`,
        `実行ID: ${result.runId}`,
        `対象: ${result.target ? `${result.target.mode} ${result.target.mergeBaseSha}...${result.target.headSha} SHA-256=${result.target.hash}` : "取得不能"}`,
        `standards: ${result.review.standards}、spec: ${result.review.spec}`,
        `探索担当: ${agentText(result.agents.exploration)}`,
        `検証担当: ${agentText(result.agents.verification)}`,
        ...(result.fixedResult ? [`固定版の結果: ${result.fixedResult.status}（${result.fixedResult.score === null ? "点数なし" : `${result.fixedResult.score}/5`}）`] : []),
        ...(result.currentSubmission ? [`現在版への提出: ${result.currentSubmission.eligible ? "固定した確認範囲で可" : "不可"}`] : []),
        ...result.problems.map(p => `${p.code}: ${p.message}`),
        `残件: ${result.remaining.join("、") || "なし"}`,
        `保存先: ${result.directory}`,
      ].join("\n"));
    }));
}
