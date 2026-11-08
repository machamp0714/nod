import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NodError } from "../errors";
import { adjudicate, reviewFocus, reviewUnits } from "./review-adjudicate";
import type { ReviewContext } from "./review-context";
import { reviewOutputSchema, reviewSchemaViolation, reviewStageOutput, type ReviewPhase, type ReviewStageOutput } from "./review-contract";
import { requireFixedStandardReferences, reviewSourceFingerprint, type ReviewPreparation } from "./review-prepare";
import { ReviewFailure, type ReviewReferenceDiagnostic } from "./review-failure";
import { reviewGit } from "./review-git";
import { readReviewResponsibility, type ReviewResponsibility } from "./review-responsibility";
import { reviewStageInput } from "./review-input";
import { readStandardScope, type StandardScope } from "./review-scope";
import { localReviewUnchanged, sensitiveReviewPath } from "./review-snapshot";

export type ReviewExplorationPhase = "standards" | "spec";
const explorationPhases: ReviewExplorationPhase[] = ["standards", "spec"];
const phaseLabel: Record<ReviewPhase, string> = { standards: "Standards探索", spec: "Spec探索", verification: "候補検証" };
/** 記録が結び付く対象版。差分・資料本文は準備の記録にだけ置く。 */
export interface ReviewRunTarget { mode: "commit" | "local"; headSha: string; mergeBaseSha: string; hash: string }
export interface ReviewStageInputFiles { inputPath: string; schemaPath: string; assignedRequirementCount: number }
/** 準備と同じ実行に固定した規約適用計画・責務計画と、探索の工程入力。点数もレビュー完了も表さない。 */
export interface ReviewPlan {
  schemaVersion: 1;
  runId: string;
  plannedAt: string;
  status: "planned";
  score: null;
  reviewCompleted: false;
  review: { standards: "not_started"; spec: "not_started" };
  target: ReviewRunTarget;
  standardScope?: StandardScope;
  responsibility?: ReviewResponsibility;
  /** 計画固定時の要求・添付関係・適用規約・計画の識別値。記録時の変化検出の基準にする。 */
  sourceFingerprint: string;
  inputs: Record<ReviewExplorationPhase, ReviewStageInputFiles>;
  remaining: string[];
  artifactPath: string;
}
/** 担当エージェントの定義名と、担当が知りうるモデル情報の申告。実効モデルの証明や停止条件には使わない。 */
export interface ReviewAgentClaim {
  definition: string;
  modelClaim: { value: string | null; source: string | null; status: "declared" | "unverified" };
}
/** 担当が書いた1工程の出力を検査した記録。出力は固定資料から出典を復元した内部表現だけを残す。 */
export interface ReviewRecordedStage {
  phase: ReviewPhase;
  status: "completed" | "incomplete";
  /** 担当が書いた出力ファイル。指定がなければnull。 */
  file: string | null;
  sha256?: string;
  format?: number;
  output: ReviewStageOutput | null;
  problem?: { code: string; message: string; referenceDiagnostic?: ReviewReferenceDiagnostic };
}
/** 探索の中間記録。採点せず、候補検証の記録が無い限りレビュー完了にならない。 */
export interface ReviewExploration {
  schemaVersion: 1;
  runId: string;
  recordedAt: string;
  status: "explored" | "exploration_incomplete";
  score: null;
  reviewCompleted: false;
  target: ReviewRunTarget;
  review: Record<ReviewExplorationPhase, "explored" | "incomplete">;
  agents: { exploration: ReviewAgentClaim };
  stages: ReviewRecordedStage[];
  problems: { code: string; message: string }[];
  remaining: string[];
  artifactPath: string;
}
/** `--check` の結果。保存しない。 */
export interface ReviewExplorationCheck { runId: string; saved: false; stages: ReviewRecordedStage[]; problems: { code: string; message: string }[] }
/** 実行の現在の段階。最後に保存された記録から読むだけで、記録を閉じたり書き換えたりしない。 */
export interface ReviewRunState {
  runId: string;
  status: "prepared" | "planned" | "explored" | "exploration_incomplete" | "completed" | "incomplete";
  score: number | null;
  reviewCompleted: boolean;
  review: { standards: string; spec: string };
  fixedResult?: ReviewFixedResult;
  currentSubmission?: { eligible: boolean };
  target: ReviewRunTarget | null;
  agents: { exploration?: ReviewAgentClaim; verification?: ReviewAgentClaim };
  problems: { code: string; message: string }[];
  remaining: string[];
  directory: string;
  artifactPath: string;
}

interface ReviewRun {
  directory: string;
  preparation: ReviewPreparation;
  plan?: ReviewPlan;
  exploration?: ReviewExploration;
  execution?: ReviewVerification;
}

const digest = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
const scopePolicy = "changes-and-explicit-requirements-v1", candidatePolicy = "diff-defects-v1";

function readRecord<T>(path: string): T | undefined {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : undefined;
}

// 実行IDは準備が割り当てたUUIDだけを受け付け、保存先の外を指させない。
function loadReviewRun(outputDir: string, runId: string): ReviewRun {
  const directory = join(resolve(outputDir), runId);
  const preparation = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId) ? readRecord<ReviewPreparation>(join(directory, "preparation.json")) : undefined;
  if (!preparation) throw new NodError("RUN_NOT_FOUND", `レビューの実行ID ${runId} の準備記録がありません`);
  return { directory, preparation, plan: readRecord<ReviewPlan>(join(directory, "plan.json")), exploration: readRecord<ReviewExploration>(join(directory, "exploration.json")),
    execution: readRecord<NonNullable<ReviewRun["execution"]>>(join(directory, "execution.json")) };
}

function preparedContext(run: ReviewRun): { target: NonNullable<ReviewPreparation["target"]>; context: ReviewContext } {
  const { status, target, context } = run.preparation;
  if (status !== "prepared" || !target || !context) throw new NodError("RUN_NOT_PREPARED", "準備が完了していない実行です。新しい準備から始めてください");
  return { target, context };
}

const runTarget = ({ mode, headSha, mergeBaseSha, hash }: NonNullable<ReviewPreparation["target"]>): ReviewRunTarget => ({ mode, headSha, mergeBaseSha, hash });

// 計画で固定した適用範囲と分担を準備の資料へ重ね、確認単位と工程入力を再現する。
function plannedPreparation(preparation: ReviewPreparation, plan: Pick<ReviewPlan, "standardScope" | "responsibility">): ReviewPreparation {
  const sources = preparation.sources.map(source => {
    const applicability = source.type === "standard" ? plan.standardScope?.standards.find(row => row.source === `standard:${source.id}`)?.ranges : undefined;
    return applicability ? { ...source, applicability } : source;
  });
  return { ...preparation, sources, standardScope: plan.standardScope, responsibility: plan.responsibility };
}

/** 探索1工程の入力。分割せず、その軸の全確認単位を1つの担当へ渡す。 */
function explorationInput(preparation: ReviewPreparation, context: ReviewContext, phase: ReviewPhase) {
  return reviewStageInput({ preparation, units: reviewUnits(preparation.sources), sourcePaths: context.sourceFiles.map(file => file.path), contextPath: context.path,
    scopePolicy, candidatePolicy, focus: reviewFocus(preparation.target!), code: context.code, baseCode: context.baseCode, excludedSources: context.excludedSources }, phase);
}

/**
 * 準備した実行に規約適用計画と責務計画を1回だけ固定し、Standards探索・Spec探索の工程入力とformat=3のschemaを保存先へ書く。
 * 計画が不正・未確認なら何も固定せず拒否し、正しい計画で再実行できる。
 */
export function planReview(db: Database, outputDir: string, input: { runId: string; scopePlan?: string; responsibilityPlan?: string }): ReviewPlan {
  const run = loadReviewRun(outputDir, input.runId);
  const { target, context } = preparedContext(run);
  if (run.plan) throw new NodError("PLAN_ALREADY_FIXED", "この実行の計画は固定済みです。計画を変えるには新しい準備から始めてください");
  const preparation = run.preparation;
  let sourceFingerprint: string;
  try {
    if (preparation.sourceFingerprint && reviewSourceFingerprint(db, preparation) !== preparation.sourceFingerprint) throw new ReviewFailure("REQUIREMENTS_CHANGED", "要求・計画・適用規約が準備後に変更されました。新しい準備が必要です");
    if (input.scopePlan) preparation.standardScope = readStandardScope(resolve(input.scopePlan), preparation.sources);
    if (input.responsibilityPlan) preparation.responsibility = readReviewResponsibility(resolve(input.responsibilityPlan), preparation.sources);
    requireFixedStandardReferences(preparation);
    sourceFingerprint = reviewSourceFingerprint(db, preparation);
  } catch (error) {
    if (error instanceof ReviewFailure) throw new NodError(error.code, error.message);
    throw error;
  }
  const inputs = join(run.directory, "inputs");
  const file = (phase: ReviewExplorationPhase, name: string) => join(inputs, `${phase}.${name}.json`);
  const stageInputs = explorationPhases.map(phase => ({ phase, body: explorationInput(preparation, context, phase) }));
  const plan: ReviewPlan = {
    schemaVersion: 1, runId: preparation.runId, plannedAt: new Date().toISOString(), status: "planned", score: null, reviewCompleted: false,
    review: { standards: "not_started", spec: "not_started" }, target: runTarget(target),
    ...(preparation.standardScope ? { standardScope: preparation.standardScope } : {}), ...(preparation.responsibility ? { responsibility: preparation.responsibility } : {}),
    sourceFingerprint,
    inputs: Object.fromEntries(stageInputs.map(({ phase, body }) => [phase, { inputPath: file(phase, "input"), schemaPath: file(phase, "schema"), assignedRequirementCount: body.assignedRequirementIds.length }])) as ReviewPlan["inputs"],
    remaining: ["Standards探索", "Spec探索と要求別の充足確認", "候補検証と要求同士の意味上の整合性確認"],
    artifactPath: join(run.directory, "plan.json"),
  };
  // plan.jsonの新規作成を固定の確定点にし、同じ実行への2回目の計画は書けない。
  writeFileSync(plan.artifactPath, JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
  mkdirSync(inputs);
  for (const { phase, body } of stageInputs) {
    writeFileSync(plan.inputs[phase].inputPath, JSON.stringify(body, null, 2) + "\n", { flag: "wx", mode: 0o444 });
    writeFileSync(plan.inputs[phase].schemaPath, JSON.stringify(reviewOutputSchema(phase, target.hash, body.assignedRequirementIds), null, 2) + "\n", { flag: "wx", mode: 0o444 });
  }
  return plan;
}

/** 工程入力とschemaのファイルの場所だけを返す。本文は大きいので標準出力へ流さない。 */
export function reviewInputFiles(outputDir: string, input: { runId: string; phase: ReviewPhase }): { runId: string; phase: ReviewPhase; inputPath: string; schemaPath: string } {
  const run = loadReviewRun(outputDir, input.runId);
  const { context } = preparedContext(run);
  if (!run.plan) throw new NodError("PLAN_REQUIRED", "工程入力は計画の固定後に作られます。先に nod review plan で計画を固定してください");
  if (input.phase === "verification") {
    if (run.exploration?.status !== "explored") throw new NodError("EXPLORATION_REQUIRED", "検証入力には完了した探索の記録が必要です");
    const request = verificationInput(plannedPreparation(run.preparation, run.plan), context, run.exploration);
    const inputPath = join(run.directory, "verification-input.json"), schemaPath = join(run.directory, "verification-schema.json");
    if (!existsSync(inputPath)) writeFileSync(inputPath, JSON.stringify(request, null, 2) + "\n", { flag: "wx" });
    if (!existsSync(schemaPath)) writeFileSync(schemaPath, JSON.stringify(reviewOutputSchema("verification", request.target.hash, request.assignedRequirementIds), null, 2) + "\n", { flag: "wx" });
    return { runId: input.runId, phase: input.phase, inputPath, schemaPath };
  }
  const { inputPath, schemaPath } = run.plan.inputs[input.phase];
  if (!existsSync(inputPath) || !existsSync(schemaPath)) throw new NodError("INPUT_MISSING", "固定した工程入力のファイルがありません。新しい準備から始めてください");
  return { runId: input.runId, phase: input.phase, inputPath, schemaPath };
}

export function reviewAgentClaim(definition: string, modelClaim?: string, modelClaimSource?: string): ReviewAgentClaim {
  const value = modelClaim?.trim() || null;
  return { definition: definition.trim(), modelClaim: { value, source: modelClaimSource?.trim() || null, status: value ? "declared" : "unverified" } };
}

/** 担当が書いた1工程の出力を、形式・工程・完了状態・固定対象hash・出典の順に検査する。失敗も記録として返す。 */
function recordedStage(phase: ReviewPhase, path: string | undefined, preparation: ReviewPreparation, context: ReviewContext): ReviewRecordedStage {
  const stage: ReviewRecordedStage = { phase, status: "incomplete", file: path === undefined ? null : resolve(path), output: null };
  const label = phaseLabel[phase];
  try {
    if (stage.file === null) throw new ReviewFailure("STAGE_MISSING", `${label}の出力ファイルが指定されていません`);
    let body: Buffer;
    try {
      const stat = statSync(stage.file);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new ReviewFailure("STAGE_UNREADABLE", `${label}の出力は16MiB以下の通常ファイルで指定してください`);
      body = readFileSync(stage.file);
    } catch (error) {
      if (error instanceof ReviewFailure) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ReviewFailure("STAGE_MISSING", `${label}の出力ファイルがありません`);
      throw new ReviewFailure("STAGE_UNREADABLE", `${label}の出力ファイルを読めません`);
    }
    stage.sha256 = digest(body);
    let value: unknown;
    try { value = JSON.parse(body.toString("utf8")); } catch { throw new ReviewFailure("OUTPUT_INVALID", `${label}の出力をJSONとして解析できません`); }
    const request = explorationInput(preparation, context, phase);
    const target = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).target : undefined;
    if (typeof target === "string" && target !== request.target.hash) throw new ReviewFailure("STALE_EVIDENCE", `${label}の出力の対象版が固定した対象と一致しません`);
    const violation = reviewSchemaViolation(value, reviewOutputSchema(phase, request.target.hash, request.assignedRequirementIds));
    if (violation) throw new ReviewFailure("OUTPUT_INVALID", `${label}の出力がformat=3のschemaに一致しません（${violation}）`);
    const { format, output } = reviewStageOutput(value, phase, { ...request, sourceCatalog: preparation.sources, unitCatalog: reviewUnits(preparation.sources) });
    stage.format = format;
    stage.output = output;
    if (!output.completed) throw new ReviewFailure("STAGE_INCOMPLETE", `${label}の担当が必要資料・確認の不足を報告しました（completed=false）`);
    stage.status = "completed";
  } catch (error) {
    stage.problem = { code: error instanceof ReviewFailure ? error.code : "OUTPUT_INVALID", message: error instanceof ReviewFailure ? error.message : `${label}の出力を処理できません`,
      ...(error instanceof ReviewFailure && error.referenceDiagnostic ? { referenceDiagnostic: error.referenceDiagnostic } : {}) };
  }
  return stage;
}

export interface ReviewExplorationInput { runId: string; standards?: string; spec?: string; agent: string; modelClaim?: string; modelClaimSource?: string }

// 計画済みの実行と、出力を検査する固定資料を読み込む。記録と検査で同じ前提条件を使う。
function explorationRun(outputDir: string, input: ReviewExplorationInput) {
  const run = loadReviewRun(outputDir, input.runId);
  const { target, context } = preparedContext(run);
  if (!run.plan) throw new NodError("PLAN_REQUIRED", "探索は計画の固定後に記録します。先に nod review plan で計画を固定してください");
  if (!input.agent.trim()) throw new NodError("AGENT_REQUIRED", "探索担当エージェントの定義名を --agent で指定してください");
  const files: Record<ReviewExplorationPhase, string | undefined> = { standards: input.standards, spec: input.spec };
  return { run, target, context, files, preparation: plannedPreparation(run.preparation, run.plan) };
}

const stageProblems = (stages: ReviewRecordedStage[]) => stages.flatMap(stage => stage.problem ? [stage.problem] : []);

/** 指定した探索出力だけを記録と同じ形式検査にかけ、保存しない。担当が記録前に出力を直すために使う。採点・引用照合はしない。 */
export function checkReviewExploration(outputDir: string, input: ReviewExplorationInput): ReviewExplorationCheck {
  const { context, files, preparation } = explorationRun(outputDir, input);
  const phases = explorationPhases.filter(phase => files[phase] !== undefined);
  if (!phases.length) throw new NodError("OUTPUT_REQUIRED", "検査する出力ファイルを --standards または --spec で指定してください");
  const stages = phases.map(phase => recordedStage(phase, files[phase], preparation, context));
  return { runId: input.runId, saved: false, stages, problems: stageProblems(stages) };
}

/**
 * Standards探索とSpec探索の出力を形式検査し、準備の実行IDと対象版に結び付けた中間記録として1回だけ保存する。採点はしない。
 * 出力の欠落・読取不能・JSON不正・形式不正・completed=falseは未完了として問題コードとともに保存する。
 */
export function recordReviewExploration(outputDir: string, input: ReviewExplorationInput): ReviewExploration {
  const { run, target, context, files, preparation } = explorationRun(outputDir, input);
  if (run.exploration) throw new NodError("EXPLORATION_ALREADY_RECORDED", "この実行の探索は記録済みです。やり直すには新しい準備から始めてください");
  const stages = explorationPhases.map(phase => recordedStage(phase, files[phase], preparation, context));
  const problems = stageProblems(stages);
  const explored = (phase: ReviewExplorationPhase) => stages.find(stage => stage.phase === phase)!.status === "completed" ? "explored" as const : "incomplete" as const;
  const exploration: ReviewExploration = {
    schemaVersion: 1, runId: input.runId, recordedAt: new Date().toISOString(), status: problems.length ? "exploration_incomplete" : "explored", score: null, reviewCompleted: false,
    target: runTarget(target), review: { standards: explored("standards"), spec: explored("spec") },
    agents: { exploration: reviewAgentClaim(input.agent, input.modelClaim, input.modelClaimSource) }, stages, problems,
    remaining: problems.length ? [...problems.map(problem => problem.message), "探索が未完了のため候補検証へ進めません。新しい準備からレビューをやり直してください"]
      : ["候補検証と要求同士の意味上の整合性確認", "採点"],
    artifactPath: join(run.directory, "exploration.json"),
  };
  writeFileSync(exploration.artifactPath, JSON.stringify(exploration, null, 2) + "\n", { flag: "wx" });
  return exploration;
}

/** 最終の検証記録。担当のモデル情報は申告であり採点の条件にはしない。 */
export interface ReviewVerification {
  schemaVersion: 1;
  runId: string;
  recordedAt: string;
  status: "completed" | "incomplete";
  score: number | null;
  reviewCompleted: boolean;
  target: ReviewRunTarget;
  reviewPolicy: "independent-v1";
  review: { standards: string; spec: string };
  scope: { kind: "full" | "limited"; excludedRequirements: string[]; excludedFindings: string[]; standardApplicability?: StandardScope };
  fixedResult?: ReviewFixedResult;
  currentSubmission: { eligible: boolean };
  agents: { exploration: ReviewAgentClaim; verification: ReviewAgentClaim };
  stages: ReviewRecordedStage[];
  requirements: Omit<ReviewPreparation["requirements"], "consistency"> & { consistency: string };
  coverage: Record<string, unknown>[];
  findings: Record<string, unknown>[];
  rootCauses: { id: string; candidates: { axis: unknown; id: unknown; decision: unknown }[] }[];
  problems: { code: string; message: string }[];
  remaining: string[];
  artifactPath: string;
}
export interface ReviewVerificationInput { runId: string; output?: string; agent: string; modelClaim?: string; modelClaimSource?: string }

export interface ReviewFixedResult { status: "completed" | "incomplete"; score: number | null; review: { standards: string; spec: string } }

async function currentTargetUnchanged(preparation: ReviewPreparation): Promise<boolean> {
  const target = preparation.target!, selection = preparation.selection;
  if (!selection) return false;
  const git = async (...args: string[]) => (await reviewGit(["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", target.repo, ...args], { cwd: target.repo })).stdout;
  const head = (await git("rev-parse", "--verify", "--end-of-options", `${selection.head}^{commit}`)).trim();
  const base = (await git("rev-parse", "--verify", "--end-of-options", `${selection.base}^{commit}`)).trim();
  return head === target.headSha && base === target.baseSha && (!target.local || await localReviewUnchanged(target.repo, target.local, git));
}

// 探索の許可項目を明示して構成する。工程出力や申告のspreadは禁止。
function verificationInput(preparation: ReviewPreparation, context: ReviewContext, exploration: ReviewExploration) {
  return { ...explorationInput(preparation, context, "verification"), candidates: exploration.stages.map(stage => ({
    axis: stage.phase,
    candidates: stage.output?.candidates ?? [],
    requirements: stage.output?.requirements.map(({ id, status, contentAssessment, implementation, verification, evidence, findingIds, scopeEvidence, rationale }) =>
      ({ id, status, contentAssessment, implementation, verification, evidence, findingIds, scopeEvidence, rationale })) ?? [],
  })) };
}

function verificationRun(outputDir: string, input: ReviewVerificationInput) {
  const run = loadReviewRun(outputDir, input.runId);
  const { target, context } = preparedContext(run);
  if (!run.plan) throw new NodError("PLAN_REQUIRED", "検証の記録には計画の固定が必要です");
  if (!run.exploration) throw new NodError("EXPLORATION_REQUIRED", "検証の記録には探索の記録が必要です");
  if (!input.agent.trim()) throw new NodError("AGENT_REQUIRED", "検証担当エージェントの定義名を指定してください");
  return { run, target, context, exploration: run.exploration, preparation: plannedPreparation(run.preparation, run.plan) };
}

/** 記録前のformat=3形式検査。引用照合・採点をせず、ファイルを書かない。 */
export function checkReviewVerification(outputDir: string, input: ReviewVerificationInput): ReviewExplorationCheck {
  const { preparation, context } = verificationRun(outputDir, input);
  const stages = [recordedStage("verification", input.output, preparation, context)];
  return { runId: input.runId, saved: false, stages, problems: stageProblems(stages) };
}

/** 固定Gitの実在行だけを引用として復元し、既存の要求対応・採点契約へ渡す。 */
async function fixedLocations(preparation: ReviewPreparation, stages: ReviewRecordedStage[], cwd: string) {
  const target = preparation.target!, locations = new Map<string, string[]>();
  const referenced = new Map<string, { revision: string; path: string }>();
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (typeof row.path === "string" && (row.revision === "head" || row.revision === "base")) referenced.set(`${row.revision}:${row.path}`, { revision: row.revision, path: row.path });
    for (const nested of Object.values(row)) collect(nested);
  };
  collect(stages.map(stage => stage.output));
  const git = (...args: string[]) => reviewGit(["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", target.repo, ...(target.local ? ["--git-dir", target.local.repo] : []), ...args], { cwd });
  for (const [key, ref] of referenced) {
    if (!ref.path || ref.path.startsWith("/") || ref.path.split("/").some(part => ["..", ".git"].includes(part)) || sensitiveReviewPath(ref.path)) continue;
    const revision = ref.revision === "head" ? target.local?.treeSha ?? target.headSha : target.mergeBaseSha;
    const entry = (await git("ls-tree", "-lz", revision, "--", ref.path)).stdout.split("\0").find(line => line.slice(line.indexOf("\t") + 1) === ref.path);
    if (!entry) continue;
    const [mode, type, oid, size] = entry.slice(0, entry.indexOf("\t")).trim().split(/\s+/);
    if (!["100644", "100755"].includes(mode!) || type !== "blob" || Number(size) > 2 * 1024 * 1024) continue;
    const blob = await git("cat-file", "blob", oid!);
    if (blob.stdoutBytes.includes(0)) continue;
    try { locations.set(key, new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(blob.stdoutBytes).replace(/\n$/, "").split("\n")); } catch { /* 不正UTF-8は証拠にしない。 */ }
  }
  const quote = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (typeof row.path === "string" && (row.revision === "head" || row.revision === "base") && Number.isInteger(row.line) && row.quote === undefined) {
      const content = locations.get(`${row.revision}:${row.path}`)?.[Number(row.line) - 1];
      if (content !== undefined) row.quote = content;
    }
    for (const nested of Object.values(row)) quote(nested);
  };
  quote(stages.map(stage => stage.output));
  return locations;
}

export async function recordReviewVerification(db: Database, outputDir: string, input: ReviewVerificationInput): Promise<ReviewVerification> {
  const { run, target, context, exploration, preparation } = verificationRun(outputDir, input);
  if (run.execution) throw new NodError("VERIFICATION_ALREADY_RECORDED", "この実行の検証は記録済みです。新しい準備から始めてください");
  const verification = recordedStage("verification", input.output, preparation, context);
  const stages = [...exploration.stages, verification];
  const problems = stageProblems(stages);
  const result: ReviewVerification = { schemaVersion: 1, runId: input.runId, recordedAt: new Date().toISOString(), status: "incomplete", score: null, reviewCompleted: false,
    target: runTarget(target), reviewPolicy: "independent-v1", review: { standards: "incomplete", spec: "incomplete" },
    agents: { exploration: exploration.agents.exploration, verification: reviewAgentClaim(input.agent, input.modelClaim, input.modelClaimSource) },
    stages, requirements: { ...preparation.requirements }, scope: { kind: "full", excludedRequirements: [], excludedFindings: [] },
    coverage: [], findings: [], rootCauses: [], problems, currentSubmission: { eligible: false }, remaining: [], artifactPath: join(run.directory, "execution.json") };
  try {
    if (!problems.length) {
      const locations = await fixedLocations(preparation, stages, context.path);
      const verdict = adjudicate(preparation, stages, locations);
      result.coverage = verdict.coverage; result.findings = verdict.findings; result.rootCauses = verdict.rootCauses;
      const excludedRequirements = verdict.coverage.filter(row => row.status === "out_of_scope").map(row => String(row.id));
      const excludedFindings = verdict.findings.filter(finding => finding.decision === "out_of_scope").map(finding => `${finding.axis}:${finding.id}`);
      result.scope = { kind: excludedRequirements.length || excludedFindings.length || preparation.standardScope?.standards.some(standard => standard.ranges.some(range => range.kind === "reference")) ? "limited" : "full",
        excludedRequirements, excludedFindings, ...(preparation.standardScope ? { standardApplicability: preparation.standardScope } : {}) };
      result.problems.push(...verdict.problems); result.score = verdict.score; result.review = verdict.review;
      result.requirements.consistency = String(verification.output?.consistency?.status ?? "unverified");
      result.status = result.score === null ? "incomplete" : "completed";
      result.reviewCompleted = result.status === "completed";
    }
    result.fixedResult = { status: result.status, score: result.score, review: { ...result.review } };
    try {
      if (reviewSourceFingerprint(db, preparation) !== run.plan!.sourceFingerprint) throw new ReviewFailure("REQUIREMENTS_CHANGED", "要求・計画・適用規約が準備後に変更されました。新しい実行が必要です");
    } catch (error) {
      result.problems.push({ code: "REQUIREMENTS_CHANGED", message: error instanceof ReviewFailure ? error.message : "固定した要求・計画・規約の現版を取得できません" });
    }
    try {
      if (!await currentTargetUnchanged(preparation)) throw new ReviewFailure("TARGET_CHANGED", "準備後に対象が変更されました。固定版の結果は現在版への承認ではありません");
    } catch {
      result.problems.push({ code: "TARGET_CHANGED", message: "準備後に対象が変更されたか、現在版を取得できません。新しい準備が必要です" });
    }
    if (result.problems.length) {
      result.status = "incomplete"; result.score = null; result.reviewCompleted = false;
      if (result.problems.some(problem => ["TARGET_CHANGED", "REQUIREMENTS_CHANGED"].includes(problem.code))) result.review = { standards: "incomplete", spec: "incomplete" };
    }
    result.currentSubmission.eligible = result.status === "completed" && result.score === 5;
  } catch (error) {
    result.score = null;
    result.review = { standards: "incomplete", spec: "incomplete" };
    result.problems.push({ code: error instanceof ReviewFailure ? error.code : "RECORD_FAILED", message: error instanceof ReviewFailure ? error.message : "検証の記録を処理できません" });
  }
  result.remaining = result.problems.map(problem => problem.message);
  writeFileSync(result.artifactPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  return result;
}

/** 実行の現在の段階・点数・担当の申告・保存先を返す。最終の候補検証記録が無い限りレビュー完了にしない。 */
export function showReview(outputDir: string, runId: string): ReviewRunState {
  const { directory, preparation, plan, exploration, execution } = loadReviewRun(outputDir, runId);
  const target = preparation.target ? runTarget(preparation.target) : null;
  const agents = { ...exploration?.agents, ...execution?.agents };
  const base = { runId, target, agents, directory };
  if (execution) return { ...base, status: execution.status, score: execution.score, reviewCompleted: execution.status === "completed", review: execution.review,
    fixedResult: execution.fixedResult, currentSubmission: execution.currentSubmission, problems: execution.problems, remaining: execution.remaining, artifactPath: execution.artifactPath };
  if (exploration) return { ...base, status: exploration.status, score: null, reviewCompleted: false, review: exploration.review, problems: exploration.problems, remaining: exploration.remaining, artifactPath: exploration.artifactPath };
  if (plan) return { ...base, status: "planned", score: null, reviewCompleted: false, review: plan.review, problems: [], remaining: plan.remaining, artifactPath: plan.artifactPath };
  return { ...base, status: preparation.status, score: null, reviewCompleted: false, review: preparation.review, problems: preparation.problems, remaining: preparation.remaining, artifactPath: preparation.artifactPath };
}
