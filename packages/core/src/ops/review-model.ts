import { reviewOutputSchema, expandReviewOutput } from "./review-contract";
import { ReviewFailure, reviewProcess, reviewCliFailure, type ReviewReferenceDiagnostic } from "./review-process";

export type ReviewPhase = "standards" | "spec" | "verification";
export interface ReviewStage {
  phase: ReviewPhase;
  status: "completed" | "incomplete";
  effectiveModels: string[];
  elapsedMs: number;
  usage: Record<string, number>;
  /** 実CLIへ渡した入力量。本文はstdinのJSON、schemaは--json-schemaのUTF-8 byte数。モデル入力本文は保存しない。 */
  input?: { bodyBytes: number; schemaBytes: number; assignedRequirementIds: number; reviewUnits: number };
  format?: number;
  cliStatus?: { exitCode: number; resultSubtype: string; apiErrorStatus: number | null };
  output: null | { completed: boolean; axis: ReviewPhase; candidates: Record<string, unknown>[]; requirements: Record<string, unknown>[]; consistency?: Record<string, unknown>; causeGroups?: Record<string, unknown>[] };
  problem?: { code: string; message: string; referenceDiagnostic?: ReviewReferenceDiagnostic };
}
const candidateKeys = ["id", "axis", "target", "location", "contract", "condition", "expectedBehavior", "failure", "impact", "evidence", "reproduction", "rootCause", "decision", "rationale", "defense", "sdk", "scopeEvidence", "needsSpecificationDecision", "changeEvidence", "origin", "baselineEvidence", "responsibility", "scopeAssessment"];
const requirementKeys = ["id", "requirement", "status", "contentAssessment", "reference", "implementation", "verification", "evidence", "axis", "target", "findingIds", "findingLinks", "scopeEvidence", "rationale"];
function records(value: unknown, keys: string[]): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(v => !v || typeof v !== "object" || Array.isArray(v))) throw new ReviewFailure("OUTPUT_INVALID", "候補または要求別記録が配列ではありません");
  return value.map(v => Object.fromEntries(keys.filter(k => Object.hasOwn(v, k)).map(k => [k, v[k]])));
}
export async function authenticate(provider: "claude" | "codex", cwd: string, deadline: number, signal: AbortSignal) {
  const auth = await reviewProcess(provider, provider === "claude" ? ["auth", "status"] : ["login", "status"], { cwd, deadline, signal });
  if (provider === "claude") {
    let data;
    try { data = JSON.parse(auth.stdout); } catch { throw new ReviewFailure("AUTH_REQUIRED", "Claudeの認証状態を解析できません"); }
    if (!data.loggedIn || data.authMethod !== "claude.ai" || data.apiProvider !== "firstParty" || !["max", "pro"].includes(data.subscriptionType)) {
      throw new ReviewFailure("AUTH_REQUIRED", "Claudeの既存個人契約による認証が必要です");
    }
    return { method: "claude.ai", subscription: data.subscriptionType as string };
  }
  if (!/Logged in using ChatGPT/.test(auth.stdout + auth.stderr)) throw new ReviewFailure("AUTH_REQUIRED", "ChatGPTによるCodex認証が必要です");
  return { method: "ChatGPT" };
}

export async function invokeReviewModel(options: {
  provider: "claude" | "codex"; model: string; effort?: string; implementationModels: string[]; phase: ReviewPhase;
  cwd: string; input: string; deadline: number; signal: AbortSignal; sourceCatalog: unknown[]; unitCatalog: unknown[];
}): Promise<ReviewStage> {
  const started = Date.now();
  const stage: ReviewStage = { phase: options.phase, status: "incomplete", effectiveModels: [], elapsedMs: 0, usage: {}, output: null };
  try {
    // 主入力は差分と要求。関係コードはrestrictedの固定snapshot内だけ読み、コマンド・外部接続・再帰Agent/Skillを提供しない。
    if (options.provider === "codex") throw new ReviewFailure("MODEL_UNVERIFIED", "Codexの毎turnの実効モデル識別子を確認できる公開契約が必要です。推論は開始しません");
    const request = JSON.parse(options.input);
    const requirementIds: string[] = request.assignedRequirementIds;
    const schema = JSON.stringify(reviewOutputSchema(options.phase, request.target.hash, requirementIds));
    stage.input = { bodyBytes: Buffer.byteLength(options.input), schemaBytes: Buffer.byteLength(schema), assignedRequirementIds: requirementIds.length, reviewUnits: request.reviewUnits.length };
    const args = ["--print", "--output-format", "json", "--model", options.model, ...(options.effort !== undefined ? ["--effort", options.effort] : []), "--json-schema", schema,
        "--safe-mode", "--restricted", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--disable-slash-commands", "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--no-session-persistence",
        "--settings", '{"fastMode":false}'];
    // 非0終了でも安全な終了metadataを保持する。モデル出力本文・stderrは保存しない。
    const response = await reviewProcess(options.provider, args, { ...options, allowNonzero: true });
    stage.cliStatus = { exitCode: response.exitCode, resultSubtype: "unavailable", apiErrorStatus: null };
    let data;
    try { data = JSON.parse(response.stdout); } catch {
      if (response.exitCode !== 0) throw reviewCliFailure(response.stdout, response.stderr, `モデルCLIが終了コード ${response.exitCode} で失敗しました`);
      throw new ReviewFailure("OUTPUT_INVALID", "ClaudeのJSONを解析できません");
    }
    const subtypes = ["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"];
    stage.cliStatus.resultSubtype = subtypes.includes(data?.subtype) ? data.subtype : "unrecognized";
    if (Number.isInteger(data?.api_error_status) && data.api_error_status >= 100 && data.api_error_status <= 599) stage.cliStatus.apiErrorStatus = data.api_error_status;
    if (data?.usage && typeof data.usage === "object") for (const [key, value] of Object.entries(data.usage)) if (typeof value === "number" && Number.isFinite(value)) stage.usage[key] = value;
    const models = data?.modelUsage && typeof data.modelUsage === "object" ? Object.keys(data.modelUsage) : [];
    stage.effectiveModels = models.filter(model => /^claude-[a-z0-9][a-z0-9._-]+$/i.test(model));
    if (response.exitCode !== 0 || data?.is_error || data?.subtype !== "success") {
      throw reviewCliFailure(data, response.stderr, `モデルCLIが失敗しました（終了コード ${response.exitCode}、種別 ${stage.cliStatus.resultSubtype}）`);
    }
    if (stage.effectiveModels.length !== models.length) throw new ReviewFailure("MODEL_UNVERIFIED", "ClaudeのmodelUsageに不正なモデル識別子があります");
    if (!stage.effectiveModels.length || stage.effectiveModels.some(model => !/^claude-[a-z0-9][a-z0-9._-]+$/i.test(model))) {
      throw new ReviewFailure("MODEL_UNVERIFIED", "ClaudeのmodelUsageに具体的な実効モデル識別子がありません");
    }
    if (stage.effectiveModels.some(model => options.implementationModels.includes(model))) throw new ReviewFailure("MODEL_OVERLAP", "実効レビューモデルが実装モデル集合と重なっています");
    let output = data.structured_output;
    if (!output || output.axis !== options.phase || typeof output.completed !== "boolean") throw new ReviewFailure("OUTPUT_INVALID", "モデルの構造化出力に工程と完了状態がありません");
    output = expandReviewOutput(output, { ...request, sourceCatalog: options.sourceCatalog, unitCatalog: options.unitCatalog });
    stage.format = output.format;
    stage.output = { axis: output.axis, completed: output.completed, candidates: records(output.candidates, candidateKeys), requirements: records(output.requirements, requirementKeys), causeGroups: output.causeGroups, consistency: output.consistency && typeof output.consistency === "object" ? output.consistency : undefined };
    if (!output.completed) throw new ReviewFailure("MODEL_REVIEW_INCOMPLETE", "モデルが必要資料・確認の不足を報告しました");
    stage.status = "completed";
  } catch (error) {
    stage.problem = { code: error instanceof ReviewFailure ? error.code : "OUTPUT_INVALID", message: error instanceof ReviewFailure ? error.message : "モデル出力を処理できません",
      ...(error instanceof ReviewFailure && error.referenceDiagnostic ? { referenceDiagnostic: error.referenceDiagnostic } : {}) };
  }
  stage.elapsedMs = Date.now() - started;
  return stage;
}
