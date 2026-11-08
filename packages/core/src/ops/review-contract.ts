import { ReviewFailure, type ReviewReferenceDiagnostic } from "./review-process";
import type { ReviewSource } from "./review-prepare";

type Row = Record<string, any>;
export type ReviewPhase = "standards" | "spec" | "verification";
/** 工程出力を検査・展開した内部の工程記録。出典hash・引用・要求本文・固定分担理由はCLIの復元値。 */
export interface ReviewStageOutput { completed: boolean; axis: ReviewPhase; candidates: Record<string, unknown>[]; requirements: Record<string, unknown>[]; consistency?: Record<string, unknown>; causeGroups?: Record<string, unknown>[] }
const text = { type: "string", minLength: 1 };
const object = (properties: Row, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const array = (items: Row) => ({ type: "array", items });
const nullable = (item: Row) => ({ anyOf: [item, { type: "null" }] });
const location = object({ path: text, revision: { enum: ["head", "base"] }, line: { type: "integer", minimum: 1 } });
// 型なしID・ファイル名・snapshotのpathはschemaの検査（モデルCLIのStructuredOutput、または記録時のreviewSchemaViolation）で弾く。全資料IDのenumはschemaを肥大化させるので使わない。
const sourceTypes = Object.keys({ issue: 1, document: 1, plan: 1, standard: 1 } satisfies Record<ReviewSource["type"], 1>);
const reference = object({ source: { ...text, pattern: `^(${sourceTypes.join("|")}):.+`, description: "sources[].sourceのtype:idをそのまま使う" }, line: { type: "integer", minimum: 1 } });
const citation = { anyOf: [reference, location] };
const comparison = object({ requirement: text, candidate: text, match: { enum: ["same", "different", "unknown"] } });
const findingLink = object({ findingAxis: { enum: ["standards", "spec"] }, findingId: text, relation: { enum: ["violation", "supporting", "rejected", "unresolved"], description: "supportingも操作・条件・期待動作の全match=sameとeffectOfFix=resolves_this_violationが必要。同原因だけでは不可。対応が異なり修正効果がunchangedならrejected、不明ならunresolvedかつ要求をunverifiedにする。" }, observedBehavior: text, requirementEvidence: { ...array(reference), minItems: 1 }, codeEvidence: { ...array(location), minItems: 1 },
  operation: comparison, condition: comparison, obligation: comparison,
  effectOfFix: { enum: ["resolves_this_violation", "unchanged", "unknown"] }, rationale: text });

/** 出典の全文・hashは繰り返さず、対象を1回固定し、参照先はランナーが照合する。分割した工程では候補IDの接頭辞と、主分割以外の採否・原因統合の禁止をschemaで示す。 */
export function reviewOutputSchema(phase: string, target: string, requirementIds: string[], shard?: { candidateIdPrefix?: string; judgesCandidates?: boolean }) {
  const candidate = object({
    id: shard?.candidateIdPrefix ? { ...text, pattern: `^${shard.candidateIdPrefix}`, description: "shard.candidateIdPrefixで始める" } : text, axis: phase === "verification" ? { enum: ["standards", "spec"] } : { const: phase }, location, contract: citation,
    condition: text, expectedBehavior: text, failure: text, impact: object({ score: { type: "integer", minimum: 0, maximum: 4 }, description: { ...text, description: "到達条件、その条件下で失う機能・状態、影響範囲と実証された回避手段を分けてscoreの根拠を説明する。発生条件が限定的という理由だけで軽微としない。機能停止だけなら一部/全入力を問わず2。0/1は重大な権限侵害・機密漏えい・回復不能な重要データ破壊等の致命的影響を先に確認し、その後で再設計の要否により区別する。局所修正で済むことだけを1の根拠にしない。" } }),
    evidence: object({ kind: { enum: ["static"] }, detail: text, recordIds: { ...array(text), maxItems: 0 } }), reproduction: text, rootCause: text,
    decision: { enum: ["required", "unverified", "false_positive", "out_of_scope", "deferred", "risk_accepted", "optional"] },
    rationale: text, defense: text, sdk: object({ status: { enum: ["verified", "not_applicable"] }, evidence: text, version: { ...nullable(text), description: "verifiedではlockfile等で解決済みの単一依存の実版。範囲指定・タグ・引用中の部分一致では不可。複数依存の版を連結しない。" }, source: nullable(location) }),
    scopeEvidence: nullable(reference), needsSpecificationDecision: { type: "boolean" }, changeEvidence: { ...nullable(location), description: "locationとは別の変更根拠。target.patchの追加行はhead、削除行はbaseを指定し、置換は該当するどちらかを使う。削除だけの差分にheadの変更行はない。未変更の周辺行・行番号のずれ・移動後の場所で代用しない。" },
    origin: { enum: ["introduced", "pre_existing", "unknown"] }, baselineEvidence: { ...nullable(location), description: "origin=pre_existingではcandidate.locationと同じpath・同じ行内容のbase参照。別ファイルの関連証拠はreferencesへ記録する。" },
    responsibility: object({ owner: { enum: ["review", "automatic_check", "unresolved"] }, rationale: text, references: array(citation) }),
    scopeAssessment: nullable(object({ kind: { enum: ["unrelated_existing", "explicit_requirement"] }, rationale: text, references: array(citation) })),
  });
  // 主分割以外の検証は候補を参照するだけで、採否・原因統合を返せない。候補の項目定義も渡さず入力量を抑える。
  const delegated = shard?.judgesCandidates === false ? { type: "array", maxItems: 0, description: "候補の採否と原因統合は主分割が担当する" } : undefined;
  return object({ format: { const: 3 }, target: { const: target }, axis: { const: phase }, completed: { type: "boolean" },
    candidates: delegated ?? array(candidate), requirements: { ...array(object({
      ...(phase === "verification" ? { findingLinks: array(findingLink) } : {}),
      id: requirementIds.length ? { ...text, enum: requirementIds } : text,
      status: { enum: ["satisfied", "unsatisfied", "unverified", "out_of_scope", "context"], description: "background/rationale/scope/validation_gapはcontext。説明をsatisfiedにしない。適用条件が今回の差分で成立しないと確認できた義務はsatisfied。適用条件や判定に必要な事実が不明ならunverified。実装義務が混在する場合はmixedとして義務を判定する。" },
      contentAssessment: object({ kind: { enum: ["obligation", "mixed", "background", "rationale", "scope", "validation_gap", "independent_check", "unknown"] }, obligations: { ...array(text), description: "obligation/mixedでは当該reviewUnitのparagraphが指すreviewParagraphs[].content（paragraphが無ければrequirement）から義務を原文どおり抜き出す。要約・言い換え・文字の追加は禁止。他のkindは空配列。" }, references: { ...array(reference), minItems: 1, description: "当該reviewUnit.requiredAssessmentReferencesの全参照を含める。行自身と段落先頭を両方含める。" }, rationale: text }),
      implementation: array(citation), verification: object({ method: { enum: ["inspection"] }, detail: text, recordIds: { ...array(text), maxItems: 0 } }), evidence: text,
      findingIds: { ...array(text), description: "この要求と同じ条件・時点・操作に反する軸付き候補ID（standards:id または spec:id）。語が同じだけの別操作の不具合へ対応付けない。" }, scopeEvidence: { ...nullable(reference), description: "既存課題または固定分担で対象外にする要求では、その要求idに対応するreviewUnits.referenceのsource/lineを使う。除外理由の範囲出典は候補のscopeAssessment.referencesへ。" }, rationale: { ...text, description: "responsibility.assignmentsの要求ではCLIが計画の固定した分担理由で置き換え、異なる文面はproposedRationaleとして別に保存する。" },
    })), maxItems: requirementIds.length, description: "assignedRequirementIdsの各IDを1回ずつ返す。担当IDが0件なら空配列。他軸や資料に存在しないIDを追加しない。" }, consistency: object({ status: { enum: ["consistent", "conflict", "unverified"] }, evidence: text }),
    causeGroups: delegated ?? array(object({ id: text, members: array(text), rationale: text })),
  });
}

export function expandReviewOutput(output: Row, input: Row): Row {
  if ((Array.isArray(output.executionChecks) && output.executionChecks.length) || output.executionEvidence !== undefined
    || [...(Array.isArray(output.candidates) ? output.candidates : []), ...(Array.isArray(output.requirements) ? output.requirements : [])].some((row: Row) =>
      ["execution", "mixed"].includes(row.evidence?.kind) || ["execution", "mixed"].includes(row.verification?.method)
      || row.evidence?.recordIds?.length || row.verification?.recordIds?.length)) {
    throw new ReviewFailure("REVIEW_LAYER_VIOLATION", "レビュー出力に自動チェックの結果または実行証拠が含まれています");
  }
  // 分割の接頭辞は詳細形式でも検査し、CLIが候補IDを書き換えて衝突を避けることはしない。
  const shard = input.shard as { candidateIdPrefix?: string; judgesCandidates?: boolean } | undefined;
  if (shard?.judgesCandidates === false && ((Array.isArray(output.candidates) && output.candidates.length) || (Array.isArray(output.causeGroups) && output.causeGroups.length))) {
    throw new ReviewFailure("OUTPUT_INVALID", "候補の採否と原因統合は検証の主分割が担当します。この分割は候補を返せません");
  }
  const prefix = shard?.candidateIdPrefix;
  if (prefix && Array.isArray(output.candidates) && output.candidates.some((c: Row) => typeof c?.id !== "string" || !c.id.startsWith(prefix))) {
    throw new ReviewFailure("OUTPUT_INVALID", `探索候補のIDが分割の接頭辞 ${prefix} で始まりません`);
  }
  if (output.format !== 2 && output.format !== 3) return output; // 既存の詳細形式も従来どおり厳密照合する。
  if (output.target !== input.target.hash) throw new ReviewFailure("STALE_EVIDENCE", "構造化出力の対象版が固定入力と一致しません");
  if (!Array.isArray(output.requirements) || !Array.isArray(output.candidates) || !Array.isArray(output.causeGroups)) throw new ReviewFailure("OUTPUT_INVALID", "構造化出力の必要な配列がありません");
  const cite = (ref: any, field: string, requirementUnitIndex: number | null = null): any => {
    if (!ref || typeof ref !== "object" || typeof ref.source !== "string") return ref;
    const sourceIndex = input.sourceCatalog.findIndex((s: Row) => `${s.type}:${s.id}` === ref.source);
    const source = input.sourceCatalog[sourceIndex], lines = source?.content.split("\n"), line = lines?.[ref.line - 1];
    if (!source || !Number.isInteger(ref.line) || ref.line < 1 || line === undefined) {
      const reason = !source ? "unknown_source" : !Number.isInteger(ref.line) ? "invalid_line" : "line_out_of_range";
      const snapshot = input.sources.filter((s: Row) => s.path === ref.source);
      const matches = input.sourceCatalog.map((s: Row, index: number) => ({ source: s, index })).filter(({ source: s }: Row) =>
        snapshot.length === 1 ? `${s.type}:${s.id}` === snapshot[0].source : s.id === ref.source);
      const matched = matches.length === 1 ? matches[0].index : null;
      const diagnostic: ReviewReferenceDiagnostic = { reason, field, requirementUnitIndex,
        sourceIndex: sourceIndex >= 0 ? sourceIndex : null,
        sourceForm: source ? "catalog_id" : matched === null ? "unknown" : snapshot.length === 1 ? "snapshot_path" : "id_without_type",
        matchedSourceIndex: source ? sourceIndex : matched,
        line: Number.isSafeInteger(ref.line) ? ref.line : null, lineCount: lines?.length ?? null };
      const label = { unknown_source: "資料IDが未登録", invalid_line: "行番号が整数ではない", line_out_of_range: "行番号が資料の範囲外" }[reason];
      throw new ReviewFailure("OUTPUT_INVALID", `固定資料にない出典です（${label}、項目: ${field}）`, diagnostic);
    }
    return { hash: source.hash, quote: line, ...ref }; // 明示された誤った引用やhashを修正して通さない。
  };
  const citations = (refs: any, field: string, unitIndex: number | null = null) => Array.isArray(refs) ? refs.map((ref, index) => cite(ref, `${field}[${index}]`, unitIndex)) : refs;
  const assigned = new Set(input.assignedRequirementIds);
  const requirements = output.requirements.map((r: Row, index: number) => {
    // 入力のreviewUnitsは担当分と参考に絞った索引なので、出典hash・引用・段落本文は固定の全単位から復元する。
    const unitIndex = input.unitCatalog.findIndex((u: Row) => u.id === r.id), unit = input.unitCatalog[unitIndex];
    const field = `requirements[${index}]`;
    if (!unit || !assigned.has(r.id)) throw new ReviewFailure("OUTPUT_INVALID", "今回の確認対象にない要求IDです");
    if ((r.target !== undefined && r.target !== output.target) || (r.axis !== undefined && r.axis !== unit.axis)) throw new ReviewFailure("STALE_EVIDENCE", "要求レコードの対象・軸が固定入力と一致しません");
    // 固定分担の理由は計画の固定値であり、hash・引用と同じくCLIが復元する。異なる文面は捨てずモデルの提案として残す。
    const fixed: string | undefined = input.responsibility?.assignments.find((a: Row) => a.source === unit.reference.source && a.line === unit.reference.line)?.rationale;
    return { ...unit, ...r, context: unit.context, axis: unit.axis, target: output.target, implementation: citations(r.implementation, `${field}.implementation`, unitIndex), scopeEvidence: cite(r.scopeEvidence, `${field}.scopeEvidence`, unitIndex),
      ...(fixed === undefined ? {} : { rationale: fixed, ...(r.rationale !== undefined && r.rationale !== fixed ? { proposedRationale: r.rationale } : {}) }),
      ...(r.contentAssessment ? { contentAssessment: { ...r.contentAssessment, references: citations(r.contentAssessment.references, `${field}.contentAssessment.references`, unitIndex) } } : {}),
      ...(Array.isArray(r.findingLinks) ? { findingLinks: r.findingLinks.map((link: Row, linkIndex: number) => ({ ...link,
        requirementEvidence: citations(link.requirementEvidence, `${field}.findingLinks[${linkIndex}].requirementEvidence`, unitIndex) })) } : {}) };
  });
  const candidates: Row[] = output.candidates.map((c: Row, index: number) => {
    const field = `candidates[${index}]`;
    if (input.phase !== "verification" && c.axis !== input.phase) throw new ReviewFailure("OUTPUT_INVALID", "探索候補の軸が担当工程と一致しません");
    if (c.target !== undefined && c.target !== output.target) throw new ReviewFailure("STALE_EVIDENCE", "候補の対象が固定入力と一致しません");
    return { ...c, target: output.target, contract: cite(c.contract, `${field}.contract`), scopeEvidence: cite(c.scopeEvidence, `${field}.scopeEvidence`),
      responsibility: c.responsibility && { ...c.responsibility, references: citations(c.responsibility.references, `${field}.responsibility.references`) },
      scopeAssessment: c.scopeAssessment && { ...c.scopeAssessment, references: citations(c.scopeAssessment.references, `${field}.scopeAssessment.references`) } };
  });
  if (input.phase === "verification") {
    const seen = new Set<string>(), groups = new Set<string>();
    for (const group of output.causeGroups) {
      if (typeof group.id !== "string" || !group.id.trim() || groups.has(group.id) || typeof group.rationale !== "string" || !group.rationale.trim() || !Array.isArray(group.members) || !group.members.length) throw new ReviewFailure("OUTPUT_INVALID", "根本原因の統合記録が不正です");
      groups.add(group.id);
      for (const member of group.members) {
        const candidate = candidates.find((c: Row) => `${c.axis}:${c.id}` === member);
        if (!candidate || seen.has(member)) throw new ReviewFailure("OUTPUT_INVALID", "根本原因の統合に未知・重複候補があります");
        seen.add(member); candidate.rootCause = group.id;
      }
    }
    if (seen.size !== candidates.length) throw new ReviewFailure("OUTPUT_INVALID", "根本原因の統合に未確認の候補があります");
  }
  return { ...output, requirements, candidates };
}

/**
 * reviewOutputSchemaが使う語彙（type・properties・required・additionalProperties・items・minItems・maxItems・minLength・pattern・minimum・maximum・enum・const・anyOf）だけでJSON Schema相当の検査を行い、最初の違反を返す。
 * 担当が返した文字列（未知の項目名を含む）は理由に含めず、schema側の項目名と配列の位置だけで場所を示す。
 */
export function reviewSchemaViolation(value: unknown, schema: Row, path = "$"): string | undefined {
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some((option: Row) => reviewSchemaViolation(value, option, path) === undefined) ? undefined : `${path}: 許可された形式のどれにも一致しません`;
  if (Object.hasOwn(schema, "const") && value !== schema.const) return `${path}: ${JSON.stringify(schema.const)} である必要があります`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path}: 許可された値（${schema.enum.join("/")}）ではありません`;
  switch (schema.type) {
    case "null": return value === null ? undefined : `${path}: nullである必要があります`;
    case "boolean": return typeof value === "boolean" ? undefined : `${path}: 真偽値である必要があります`;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `${path}: 整数である必要があります`;
      if (typeof schema.minimum === "number" && value < schema.minimum) return `${path}: ${schema.minimum}以上である必要があります`;
      if (typeof schema.maximum === "number" && value > schema.maximum) return `${path}: ${schema.maximum}以下である必要があります`;
      return;
    case "string":
      if (typeof value !== "string") return `${path}: 文字列である必要があります`;
      if (typeof schema.minLength === "number" && [...value].length < schema.minLength) return `${path}: 空にできません`;
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) return `${path}: 形式が一致しません（${schema.pattern}）`;
      return;
    case "array": {
      if (!Array.isArray(value)) return `${path}: 配列である必要があります`;
      if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path}: ${schema.minItems}件以上必要です`;
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path}: ${schema.maxItems}件以下である必要があります`;
      for (const [index, item] of value.entries()) {
        const violation = schema.items ? reviewSchemaViolation(item, schema.items, `${path}[${index}]`) : undefined;
        if (violation) return violation;
      }
      return;
    }
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return `${path}: オブジェクトである必要があります`;
      const row = value as Row, properties: Row = schema.properties ?? {};
      for (const key of schema.required ?? []) if (!Object.hasOwn(row, key)) return `${path}.${key}: 必須の項目がありません`;
      if (schema.additionalProperties === false && Object.keys(row).some(key => !Object.hasOwn(properties, key))) return `${path}: schemaに無い項目があります`;
      for (const [key, property] of Object.entries(properties)) {
        const violation = Object.hasOwn(row, key) ? reviewSchemaViolation(row[key], property, `${path}.${key}`) : undefined;
        if (violation) return violation;
      }
      return;
    }
  }
}

const candidateKeys = ["id", "axis", "target", "location", "contract", "condition", "expectedBehavior", "failure", "impact", "evidence", "reproduction", "rootCause", "decision", "rationale", "defense", "sdk", "scopeEvidence", "needsSpecificationDecision", "changeEvidence", "origin", "baselineEvidence", "responsibility", "scopeAssessment"];
const requirementKeys = ["id", "requirement", "status", "contentAssessment", "reference", "implementation", "verification", "evidence", "axis", "target", "findingIds", "findingLinks", "scopeEvidence", "rationale", "proposedRationale"];
function records(value: unknown, keys: string[]): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(v => !v || typeof v !== "object" || Array.isArray(v))) throw new ReviewFailure("OUTPUT_INVALID", "候補または要求別記録が配列ではありません");
  return value.map(v => Object.fromEntries(keys.filter(k => Object.hasOwn(v, k)).map(k => [k, v[k]])));
}

/**
 * 1工程の出力の工程・完了状態・配列を検査し、固定資料から出典hash・引用・要求本文・固定分担理由を復元して内部の工程記録へ変換する。
 * モデルの起動とは独立しており、担当エージェントが書いた出力の記録とモデルCLIの構造化出力の両方に使う。完了状態の扱いは呼出側が決める。
 */
export function reviewStageOutput(value: unknown, phase: ReviewPhase, input: Row): { format?: number; output: ReviewStageOutput } {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
  if (!row || row.axis !== phase || typeof row.completed !== "boolean") throw new ReviewFailure("OUTPUT_INVALID", "工程の出力に工程と完了状態がありません");
  const output = expandReviewOutput(row, input);
  return { format: output.format, output: { axis: output.axis, completed: output.completed, candidates: records(output.candidates, candidateKeys), requirements: records(output.requirements, requirementKeys),
    causeGroups: output.causeGroups, consistency: output.consistency && typeof output.consistency === "object" ? output.consistency : undefined } };
}

export const compactReviewInstructions = `
通常レビューの候補方針はdiff-defects-v1。target.patchのbase（merge-base）との差分を起点とし、今回発生・悪化した具体的な不具合、または今回のIssue/Spec/承認計画の明示要件の実装漏れだけを探索する。関連コードは変更の呼出元・利用側・契約・防御と影響を確認するために読む。変更行だけへ読取を制限しない一方、リポジトリ全体の品質監査や差分外の改善点探しへ広げない。
一般的な整理、重複、表記、命名、好み、将来の追加変更でずれるかもしれない設計懸念は、差分内であっても候補にしない。任意の改善案を収集・提案するモードではない。具体的な契約不具合や今回の明示要件への違反がある場合だけ、変更との関係・現在の到達条件・実際の影響を根拠として候補にする。候補0件も正常。
無関係な既存課題を探し回らない。差分の影響確認中に偶然見つかった既存課題だけ、既存のscopeAssessment規則に従って根拠付き対象外として残す。
探索・verificationとも、候補のexpectedBehaviorが固定資料・関連コードから導けるかを、対象・適用条件・例外・詳細を含む文脈全体で確認する。肯定文、例示、概要、列挙にないことだけから「それだけ」「他は禁止」「全てを記載する」という排他性・網羅性を追加しない。概要の省略と詳細との矛盾を区別する。一方、明示された禁止・保証への反例や、必須とされた記載の欠落は、その適用範囲を照合して判定する。契約の根拠を明文だけに限定せず、固定コードの呼出関係・制御・データフローから導ける到達条件と破綻も確認する。
「既定を使う」「Xへ委ねる」「Xの標準動作に従う」という記述は、委譲先の既定動作を上書き・再実装せず使うという契約であり、委譲先の条件・制限を含めて読む。委譲先が実行形態や環境により別の経路を選ぶこと自体を契約違反にせず、呼出元が特定の経路・資格情報・結果まで保証したと読み足さない。その経路や結果を明示した要求、または別の適用契約がある場合は、その契約で判定する。
出力形式は以下のformat=3を使う。targetはトップレベルにtarget.hashを1回だけ返し、全レコードをその版に結び付ける。
requirementsはid,status,contentAssessment,implementation,verification,evidence,findingIds,scopeEvidence,rationaleを返し、verification工程だけfindingLinksも返す。
assignedRequirementIdsがこの工程で回答する要求IDの全件である。requirementsには各IDを1回ずつ返し、0件なら[]を返す。reviewUnitsのうち担当外の単位（Standards探索に渡すSpec単位）は主要求と候補の契約を確認する参考であり、そのIDの要求レコードを追加しない。担当外の規約単位は入力に含めないので、必要な規約本文はsourcesのpathからReadする。規約の必須要求が0件でも差分の不具合探索は行うが、規約要求を創作しない。
satisfiedは、確認単位の義務が適用される全ての主張・対象・入口・実行形態・条件分岐について、適合を固定証拠で確認した場合だけ返す。一部の主張や1つの経路の証拠を全体へ広げない。適用が限定されない義務で確認した経路をevidenceに書き分け、未確認の経路が残ればunverified、欠落を確認できればunsatisfiedと候補にする。原文が適用を限定している場合は、対象外の経路へ義務を広げない。Skillや手順書の指示文は、指示内容が義務に適合するかを静的に確認する。指示に従うエージェント・人の実際の行動は確認すべき経路に数えず、動作評価が未実施であることだけでunverifiedにしない。要求が評価の実施や観測結果を明示的に求める場合は別である。説明だけの行は、差分と矛盾しないことを理由にsatisfiedへ上げずcontextのままとする。requirements.unresolvedReferencesは固定対象に無い参照先である。今回の判定に必要な資料なら該当要求をunverifiedとし、不足を示す。義務の適用条件が今回の差分で成立しないと固定資料から確認できる場合は、その理由をevidenceへ示してsatisfiedとし、適用条件を確認した固定コードまたは固定資料の参照をimplementationへ1件以上記録する。satisfiedのimplementationを空にしない。
contentAssessmentで、各確認単位をobligation（実装要求）/mixed（説明と要求の混在）/background（背景）/rationale（根拠）/scope（範囲宣言）/validation_gap（検証実績や未検証領域の説明）/independent_check（事前に分担した独立検査だけ）/unknownに分類する。rationaleとreferencesに当該行・段落先頭行を含む固定出典を示す。見出しだけで分類せず全文と段落の主語・条件を読む。obligation/mixedのobligationsは段落から実装義務を表す部分を原文のまま全て抜き出す。その他はobligations=[]。探索が挙げた義務は検証で削除・短縮しない。意味が不明ならunknownとunverifiedで保持する。
説明だけと探索・検証が同じkindで確認した場合はstatus=contextとし、implementation=[]を許す。contextは説明を確認した記録で、実装の充足でも対象外への変更でもない。背景や未検証の説明に新たな実装義務を作らず、混在する必須要求はmixedとして通常どおり確認する。今回の必須作業や要対応・未確認候補がある行をcontextで隠さない。範囲宣言の制約を実装が破る場合や「検証する」という実施義務はobligation/mixedである。
同じ段落の別行に要対応候補があることだけでは説明行を実装要求へ変えない。verificationでcontextを返す行は、その段落の範囲内（paragraphが無ければ当該行）に契約参照を持つ両軸のrequired/unverified候補を全て照合する。別行のrequired候補と無関係だと確認できる場合だけ、findingLinksにrelation=rejected、effectOfFix=unchangedを記録し、操作・条件・期待動作の少なくとも一つの具体的な相違と、説明行・段落先頭・候補の契約行の固定参照を示す。これは行への対応の棄却であり候補自体は棄却しない。同じ行への指摘、未確認候補、条件・例外として同じ義務に属する行、対応の不明・証拠不足はcontextで隠さない。義務や条件を含む行はobligation/mixedとして保持し、不明ならunverifiedとする。分類のために無関係な候補を新たに作らない。
independent_checkはresponsibility.assignmentsに登録された純粋な検査要求だけに使う。複合要求を丸ごと分担していたらunknown/unverifiedとして誤分類を報告し、意味・設計部分を消さない。外部URLの稼働確認をしないことと、必須の静的仕様が不足していることを区別し、後者は未確認のままにする。
実装要求はimplementationに関係するコード行を示す。範囲宣言や文書契約は固定資料の{source,line}でも照合できる。資料の存在だけで実装済みと判定しない。
要求本文・axis・reference・hash・引用全文は再出力しない。CLIが固定reviewUnitsのidから対応を復元する。
reviewUnits[].paragraphはreviewParagraphs[].idを指し、その段落は同じ固定資料のsource・startLine・endLine・contentを1回だけ持つ。段落は改行で分かれた主語・条件・時点・操作を保持するために読む。要求IDは行別のままだが、行だけを独立した要求へ読み替えない。見出し等の前提が必要ならsourcesのpathも読む。参考行が段落に含まれても、その行を新たな必須要求にしない。
各reviewUnit.requiredAssessmentReferencesは本文分類のreferencesに必ず含める参照一覧である。obligationsは同じunitのparagraphが指す段落のcontent（paragraphが無ければrequirement）に実在する文字列をそのまま使い、主語の補完・要約・言い換えをしない。説明だけのbackground/rationale/scope/validation_gapではstatus=context、obligations=[]とし、satisfiedやout_of_scopeに置き換えない。実装義務を含む範囲制約はmixed/obligationで確認する。
候補の妥当性と要求への対応は別に検証する。verificationの各要求のfindingLinksに、対応を検討した候補ごとにfindingAxis（元の軸）、findingId（元のID）、relation（violation/supporting/rejected/unresolved）、observedBehavior（候補failureと同じ実動作）、requirementEvidence（当該要求行と段落先頭行を含む固定source/line）、codeEvidence（候補locationまたは候補のresponsibility.referencesにあるコードを含む固定参照）を記録する。operation（操作・発火タイミング）、condition（到達条件）、obligation（期待動作）の各項目でrequirementとcandidateを別々に具体化してmatch=same/different/unknownを比較する。各候補のexpectedBehaviorに契約が求める期待動作、failureに実際の誤動作を別々に書く。obligation.candidateはexpectedBehaviorと同一の文を使い、observedBehaviorはfailureと同一の文を使う。期待動作を誤動作と同一視しない。
effectOfFixは、その候補の原因だけを直すと当該要求の該当違反が解消するならresolves_this_violation、要求違反が変わらなければunchanged、判定不能ならunknown。複合要求の他の独立違反まで全て解消する必要はない。rationaleに固定した条件下での対応と修正効果の根拠を簡潔に記す。
relation=violationは操作・条件・期待動作の全match=sameかつeffectOfFix=resolves_this_violationを必要とし、軸付きID（axis:id）をfindingIdsへ入れる。他軸の候補も元の軸とIDを保って参照でき、要求の軸を移動したり候補を複製したりしない。
relation=supportingも全match=sameかつeffectOfFix=resolves_this_violationを必要とする。そのうえで要求status=unsatisfied、候補が対象外またはfindingIdsにある要対応と同じ原因の別の要対応である場合だけ、findingIdsから除いて補足に保持できる。同じ原因や関連分野というだけではsupportingにしない。異なる期待動作や不明な修正効果を、通すために一致へ書き換えない。対象外の存在だけで今回の未充足を消さない。
操作・条件・期待動作の対応が異なり、その候補を直しても当該要求違反が変わらないと確認できるならrelation=rejected、effectOfFix=unchangedとして残し、findingIdsに入れない。対応または修正効果が不明ならrelation=unresolvedかつ要求をunverifiedとする。対応の検討がなければfindingLinks=[]。候補の契約参照自体も同じ条件で成立するか確認し、成立しない文書参照は適切なコード契約・利用側の参照に訂正する。候補を無理に要求へ結び付けたり、対応しないというだけで独立した不具合を棄却したりしない。
根拠は短く具体的に記述する。path/revision/lineの参照にはquoteを書かない。固定コードの行全文をCLIが取得して照合する。
固定資料の出典（contract・scopeEvidence・contentAssessment.references・implementation・responsibility.references・scopeAssessment.references・findingLinks.requirementEvidence）は{source,line}だけを返す。sourceはsources[].source・reviewUnits.reference.sourceと同じtype:id（例 standard:AGENTS.md）を省略せずに使い、ファイル名・sourcesのpath・typeなしのidにしない。hash・quoteは書かず、CLIが固定資料から復元する。検証へ渡す探索記録の出典に付くhash・quoteもCLIの復元値であり、出力では同じsourceとlineだけを返す。CLIは索引に無い出典・範囲外の行を拒否する。
contractはsource/lineまたはpath/revision/line、scopeEvidenceはsource/lineで出典を指定する。
sdk.status=verifiedではlockfile等で解決済みの単一依存の実版を確認し、sdk.versionをsdk.sourceの引用値と一致させる。package.json等の^・~・不等号・wildcard・タグは実版ではなく、そこから数値だけを抜き出しても証拠にならない。実版が不明なら未確認とする。複数の依存名・版を連結しない。追加の依存が論証に必要なら、その実版と契約をevidenceへ記し、固定参照をresponsibility.referencesへ追加する。引用と版が対応しない候補を、通すためにnot_applicableへ変えない。
今回導入・悪化・顕在化させた問題はorigin=introducedとし、changeEvidenceで今回の変更行を示す。locationは不具合を説明する場所、changeEvidenceは原因を導入した差分の行であり、同じ参照を機械的に複写しない。target.patchの+行はhead、-行はbaseの行番号で示す。削除だけの変更では残ったheadの周辺行は変更根拠にならず、削除されたbase行を使う。ファイル全体が消えた場合はlocationもbaseの実在行を使える。置換では原因となる追加行または削除行を指定する。行番号の移動や同じhunkにあることだけでは変更行にならない。削除箇所と現在の失敗をevidenceで結び付け、検証工程でもこの差分対応を独立に確認する。場所が差分外でも呼出側の変更が影響するなら対象内。基点から同じ条件で存在する問題はorigin=pre_existingとし、baselineEvidenceはcandidate.locationと対になる証拠で、location.revision=head、baselineEvidence.revision=base、両者のpathと行内容が同一となる行を示す。行番号は変更前後で異なってよい。関連する別ファイルのbase行を代わりに使わず、それはscopeAssessment.referencesへ記録する。行の一致だけで影響なしとは判断せず、変更した利用側・到達条件も読む。出自不明はorigin=unknownかつunverified。
既存問題はscopeAssessmentで今回の要求との関係を区別する。今回のIssue/Specがその既存不具合の修正を明示的に要求するならkind=explicit_requirement、decision=required、changeEvidence=nullとし、rationaleとreferencesにその要求を示す。今回の変更で悪化せず、その修正も要求されていないならkind=unrelated_existing、decision=out_of_scope、changeEvidence=null、scopeEvidence=null、needsSpecificationDecision=false。referencesには現在のIssue/Document/計画による作業範囲の固定参照を1件以上含める。基点の証拠と範囲の理由を保持し、点数・未完了・自動修正から除く。既存規約や再構成した過去の契約を参考入力へ含めたことを、今回その全不整合を修正する約束と解釈しない。具体的な作業範囲が不明ならscopeAssessment=nullかつunverified。その他の候補はscopeAssessment=nullでよい。
スコープ外の既存問題だけに対応する要求行はout_of_scopeとし、軸付き候補ID（axis:id）をfindingIds、当該要求idに対応するreviewUnits.referenceのsourceとlineをそのままscopeEvidence、除外理由をrationaleへ記録する。scopeEvidenceは除外する要求の識別に使う。範囲宣言の行はscopeAssessment.referencesへ記録し、要求行のscopeEvidenceと入れ替えない。未充足の事実と基点の証拠をevidenceへ残し、satisfiedへ変更しない。複合要求に今回の要対応や未確認が含まれる場合は要求全体を対象外にしない。今回満たすと明示した要求は、既存という理由で除外しない。
baseCodeは基点側の固定コードの索引。基点本文はbaseCode.directory配下の元と同じ相対パス（directory/path）に置く。baseCode.pathsはheadと内容が異なるか、headに無い基点ファイル。それ以外にheadと同内容の基点ファイルがsameAsHead件あり、code.pathsの同じパスでdirectory配下にもある。directory配下に無いcode.pathsは基点に無いか読み込んでいない。directory/pathをReadして変更前からの不一致を確認し、baselineEvidenceにはdirectoryを付けない元のpath/revision=base/lineを返す。必要な基点資料がdirectory配下に無ければ既存問題と断定しない。
探索候補のaxisは担当工程と一致させる。検証では探索候補のaxisとidの両方を保持する。観点の再分類はrationaleへ書き、識別子を変更しない。
verificationはcauseGroupsへ全候補のaxis:idを1回ずつ割り当て、同じ到達条件・破綻の原因を同じ短いidへ統合する。rationaleに統合/分離の理由を記録する。候補本文の原因名の文字列一致だけで判断しない。同じ原因へ統合しても採否を機械的にそろえず、各軸の契約と証拠で判断する。探索ではcauseGroups=[]でよい。
検証時に任意改善が混入していたら候補IDを消さずoptionalとして監査記録へ残す。任意の設計案の選択や将来のドリフトだけでunverifiedにしない。optionalからrequired/unverifiedへ変更するときは、今回の必須要求または変更による具体的不具合への関係・影響と、その変更を支持する固定証拠をrationaleに示す。同原因というだけでは採否変更の根拠にならない。
自動チェックとレビューは独立している。Biome・lint・型検査・ビルド・テスト・再現コードを実行せず、その成否・診断・ログ・要約・実行証拠も取得しない。候補検証はコード・契約・到達条件・影響を独立して読解する。evidence.kind=static、verification.method=inspection、recordIds=[]を使う。実行しないと確認できないレビュー対象の懸念は未確認とする。
外部URLの現在の到達性検査、書式・lint・型エラー・既存テスト合否は自動チェック担当であり、探索で再検出しない。意味・設計上の問題、テストの期待値・検出範囲、CIの設計不備は対象とする。
各候補にresponsibility:{owner:review|automatic_check|unresolved,rationale:担当の理由,references:固定資料またはコードの参照配列}を付け、確信度や採否より先に担当を検証する。自動チェック担当の候補が探索に混入しても、検証でid・axisと根拠を保持してowner=automatic_check、decision=out_of_scope、scopeEvidence=null、needsSpecificationDecision=falseにする。referencesは適用する検査設定・規約などの固定参照を1件以上必要とする。チェックの実行・成功・失敗を推測せず、実行しないからunverified、軽微だからoptionalとはしない。対象外の候補は監査用に残り、減点・自動修正・未完了の理由にしない。
例：末尾改行やインデントの違反そのものはautomatic_check。同じBiomeという語を含んでも、hookが失敗終了値を成功へ変える制御経路や検査対象を誤るCI設定はreview。書式の乱れから「hookが動かなかった」と推測して設計不備へ言い換えず、設計不備は独立したコード根拠を必要とする。担当を決める根拠が足りない場合だけowner=unresolved、decision=unverifiedとする。
候補の担当判定は要求の担当を変更しない。automatic_check候補だけを根拠に要求をunsatisfiedやunverifiedにせず、固定要求の意味・設計部分を別に確認する。分担に未登録の要求を、自動チェック担当を理由に対象外へ移さない。
responsibility.assignmentsは実行前に固定した自動チェック担当の要求。該当sourceとlineの要求はstatus=out_of_scope、scopeEvidence=その要求のreferenceを返す。その要求のrationaleはCLIが計画の固定した分担理由で復元するので書き写さなくてよい。異なる文面は判定に使わず、proposedRationaleとして別に保存する。要求を省略せず、合否を推測しない。未登録の要求を自動チェック担当に変更しない。複合要求の意味・設計部分はレビューで確認する。
入力のsourcesは資料索引（source・title・path・lines・headings）。資料全文はpathの固定ファイルから必要時にReadする。standardScopeがあれば規約の適用範囲と理由はそこにだけ記載し、standardScopeに無い規約（referenceOnly）は全行が参考範囲である。規約適用計画がある場合は、必須範囲に抜けがないかもその根拠と参照資料を確認する。疑義があるならcompleted=falseとし、計画を根拠に必須要求を無視しない。
`;
