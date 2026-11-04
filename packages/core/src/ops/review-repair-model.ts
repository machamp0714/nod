import { authenticate } from "./review-model";
import { ReviewFailure, reviewProcess, reviewCliFailure } from "./review-process";

export interface RepairModelResult {
  status: "completed" | "incomplete";
  effectiveModels: string[];
  usage: Record<string, number>;
  elapsedMs: number;
  output?: { completed: boolean; target: string; needsSpecificationDecision: boolean; rationale: string; changes: { path: string; content: string | null; findingIds: string[] }[] };
  problem?: { code: string; message: string };
}

/** モデルには固定資料の読取だけを許し、書込は検査後にCLIが隔離領域へ行う。 */
export async function invokeRepairModel(options: {
  provider: "claude" | "codex"; model: string; implementationModels: string[]; reviewModels: string[];
  input: string; cwd: string; deadline: number; signal: AbortSignal;
}): Promise<RepairModelResult> {
  const started = Date.now();
  const result: RepairModelResult = { status: "incomplete", effectiveModels: [], usage: {}, elapsedMs: 0 };
  try {
    if (!["claude", "codex"].includes(options.provider)) throw new ReviewFailure("PROVIDER_INVALID", "修正providerはclaudeまたはcodexです");
    await authenticate(options.provider, options.cwd, options.deadline, options.signal);
    if (options.provider === "codex") throw new ReviewFailure("MODEL_UNVERIFIED", "Codexの毎turnの実効モデルを確認できないため、修正の推論は開始しません");
    const schema = { type: "object", additionalProperties: false, required: ["completed", "target", "needsSpecificationDecision", "rationale", "changes"], properties: {
      completed: { type: "boolean" }, target: { type: "string" }, needsSpecificationDecision: { type: "boolean" }, rationale: { type: "string" },
      changes: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "content", "findingIds"], properties: { path: { type: "string" }, content: { type: ["string", "null"] }, findingIds: { type: "array", items: { type: "string" } } } } },
    } };
    const response = await reviewProcess(options.provider, ["--print", "--output-format", "json", "--model", options.model, "--json-schema", JSON.stringify(schema),
      "--safe-mode", "--restricted", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--no-session-persistence", "--settings", '{"fastMode":false}'], options);
    let data;
    try { data = JSON.parse(response.stdout); } catch { throw new ReviewFailure("OUTPUT_INVALID", "修正モデルのJSONを解析できません"); }
    if (data.is_error || data.subtype !== "success") throw reviewCliFailure(data, "", "修正モデルが実行失敗を返しました");
    result.effectiveModels = data.modelUsage && typeof data.modelUsage === "object" ? Object.keys(data.modelUsage) : [];
    if (data.usage && typeof data.usage === "object") for (const [key, value] of Object.entries(data.usage)) if (typeof value === "number") result.usage[key] = value;
    if (!result.effectiveModels.length || result.effectiveModels.some(m => !/^claude-[a-z0-9][a-z0-9._-]+$/i.test(m))) throw new ReviewFailure("MODEL_UNVERIFIED", "修正の実効モデルをmodelUsageから確認できません");
    if (result.effectiveModels.some(m => options.reviewModels.includes(m))) throw new ReviewFailure("MODEL_OVERLAP", "修正の実効モデルがレビュー担当と重なっています");
    if (result.effectiveModels.some(m => !options.implementationModels.includes(m))) throw new ReviewFailure("REPAIR_MODEL_UNEXPECTED", "修正の実効モデルが利用者の指定した実装モデル集合にありません");
    const out = data.structured_output;
    if (!out || typeof out.completed !== "boolean" || typeof out.target !== "string" || typeof out.needsSpecificationDecision !== "boolean" || typeof out.rationale !== "string" || !out.rationale.trim() || !Array.isArray(out.changes)) throw new ReviewFailure("OUTPUT_INVALID", "修正出力の必須項目がありません");
    result.output = out;
    if (out.needsSpecificationDecision) throw new ReviewFailure("SPECIFICATION_DECISION_REQUIRED", "新たな仕様判断が必要なため修正を止めました");
    if (!out.completed) throw new ReviewFailure("REPAIR_INCOMPLETE", "修正モデルが未完了を報告しました");
    result.status = "completed";
  } catch (error) {
    result.problem = { code: error instanceof ReviewFailure ? error.code : "OUTPUT_INVALID", message: error instanceof ReviewFailure ? error.message : "修正モデルの出力処理に失敗しました" };
  }
  result.elapsedMs = Date.now() - started;
  return result;
}
