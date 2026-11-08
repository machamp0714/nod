import { expect, test } from "bun:test";
import { expandReviewOutput, reviewOutputSchema } from "../../core/src/ops/review-contract";
import { ReviewFailure } from "../../core/src/ops/review-process";

function fixture() {
  const source = { type: "document", id: "fixed", content: "要求\n説明", hash: "fixed-hash" };
  const unit = { id: "requirement", axis: "spec", reference: { source: "document:fixed", line: 1 } };
  return { input: { phase: "spec", target: { hash: "target" }, assignedRequirementIds: [unit.id], sourceCatalog: [source], unitCatalog: [unit], sources: [{ source: "document:fixed", path: ".review-input/source-0.txt" }] },
    output: { format: 3, target: "target", axis: "spec", requirements: [{ id: unit.id, implementation: [] }], candidates: [], causeGroups: [] } as any };
}

const fields = ["implementation", "scopeEvidence", "contentAssessment.references", "findingLinks.requirementEvidence", "contract", "candidateScopeEvidence", "responsibility.references", "scopeAssessment.references"];
for (const field of fields) test(`参照エラーを出力項目へ対応させ、モデルの文字列を診断へ出さない（${field}）`, () => {
  const { input, output } = fixture(), ref = { source: "未検証の秘密値に相当する文字列", line: 3 };
  let expected: string, unitIndex: number | null = 0;
  const row = output.requirements[0];
  if (field === "implementation") { row.implementation = [ref]; expected = "requirements[0].implementation[0]"; }
  else if (field === "scopeEvidence") { row.scopeEvidence = ref; expected = "requirements[0].scopeEvidence"; }
  else if (field === "contentAssessment.references") { row.contentAssessment = { references: [ref] }; expected = "requirements[0].contentAssessment.references[0]"; }
  else if (field === "findingLinks.requirementEvidence") { row.findingLinks = [{ requirementEvidence: [ref] }]; expected = "requirements[0].findingLinks[0].requirementEvidence[0]"; }
  else {
    unitIndex = null;
    const c: any = { axis: "spec", id: "candidate" }; output.candidates = [c];
    if (field === "contract") { c.contract = ref; expected = "candidates[0].contract"; }
    else if (field === "candidateScopeEvidence") { c.scopeEvidence = ref; expected = "candidates[0].scopeEvidence"; }
    else if (field === "responsibility.references") { c.responsibility = { references: [ref] }; expected = "candidates[0].responsibility.references[0]"; }
    else { c.scopeAssessment = { references: [ref] }; expected = "candidates[0].scopeAssessment.references[0]"; }
  }
  try { expandReviewOutput(output, input); throw new Error("不正参照が通った"); }
  catch (error) {
    expect(error).toBeInstanceOf(ReviewFailure);
    const e = error as ReviewFailure;
    expect(e.code).toBe("OUTPUT_INVALID");
    expect(e.referenceDiagnostic).toMatchObject({ reason: "unknown_source", field: expected, requirementUnitIndex: unitIndex, sourceIndex: null, sourceForm: "unknown", line: 3, lineCount: null });
    expect(e.message + JSON.stringify(e.referenceDiagnostic)).not.toContain(ref.source);
  }
});

for (const [line, reason] of [["秘密の行番号文字列", "invalid_line"], [0, "line_out_of_range"], [-1, "line_out_of_range"], [3, "line_out_of_range"], [1.5, "invalid_line"]] as const) test(`資料IDの誤りと行の誤りを区別する（${reason}/${typeof line}/${String(line).length}）`, () => {
  const { input, output } = fixture();output.requirements[0].implementation = [{ source: "document:fixed", line }];
  try { expandReviewOutput(output, input); throw new Error("不正行が通った"); }
  catch (error) {
    const e = error as ReviewFailure;
    expect(e.referenceDiagnostic).toMatchObject({ reason, sourceIndex: 0, sourceForm: "catalog_id", matchedSourceIndex: 0, line: Number.isSafeInteger(line) ? line : null, lineCount: 2 });
    expect(e.message + JSON.stringify(e.referenceDiagnostic)).not.toContain("秘密の行番号文字列");
  }
});

for (const [source, sourceForm] of [["fixed", "id_without_type"], [".review-input/source-0.txt", "snapshot_path"]] as const) test(`固定入力から取り違えを識別しても自動補正しない（${sourceForm}）`, () => {
  const { input, output } = fixture();output.requirements[0].implementation = [{ source, line: 1 }];
  try { expandReviewOutput(output, input); throw new Error("不正IDを補正した"); }
  catch (error) { expect((error as ReviewFailure).referenceDiagnostic).toMatchObject({ reason: "unknown_source", sourceForm, matchedSourceIndex: 0, sourceIndex: null }); }
});

test("正しい出典の復元を維持し、明示された偽引用は上書きしない", () => {
  const { input, output } = fixture();output.requirements[0].implementation = [{ source: "document:fixed", line: 2 }, { source: "document:fixed", line: 1, quote: "偽引用" }];
  const result = expandReviewOutput(output, input);
  expect(result.requirements[0].implementation).toEqual([{ source: "document:fixed", line: 2, quote: "説明", hash: "fixed-hash" }, { source: "document:fixed", line: 1, quote: "偽引用", hash: "fixed-hash" }]);
});

test("出力schemaの全ての固定資料参照は型付きの資料IDだけを受け付ける", () => {
  const schema: any = reviewOutputSchema("verification", "target", ["requirement"]);
  const candidate = schema.properties.candidates.items.properties, requirement = schema.properties.requirements.items.properties;
  const sites = {
    contract: candidate.contract.anyOf[0], candidateScopeEvidence: candidate.scopeEvidence.anyOf[0],
    "responsibility.references": candidate.responsibility.properties.references.items.anyOf[0],
    "scopeAssessment.references": candidate.scopeAssessment.anyOf[0].properties.references.items.anyOf[0],
    "contentAssessment.references": requirement.contentAssessment.properties.references.items, implementation: requirement.implementation.items.anyOf[0],
    scopeEvidence: requirement.scopeEvidence.anyOf[0], "findingLinks.requirementEvidence": requirement.findingLinks.items.properties.requirementEvidence.items,
  };
  // schemaの全箇所を走査し、source/lineの参照に漏れがないことも確かめる。
  const found: any[] = [];
  const walk = (node: any): void => { if (!node || typeof node !== "object") return; if (node.properties?.source && node.properties?.line) found.push(node); Object.values(node).forEach(walk); };
  walk(schema);
  expect(found).toHaveLength(Object.keys(sites).length);
  for (const [field, reference] of Object.entries(sites)) {
    expect(found, field).toContain(reference);
    const source = reference.properties.source, pattern = new RegExp(source.pattern);
    expect(source.description, field).toContain("sources[].source");
    for (const valid of ["standard:AGENTS.md", "issue:NOD-64", "document:docs/review-run.md", "plan:NOD-64"]) expect(pattern.test(valid), `${field}: ${valid}`).toBe(true);
    for (const invalid of ["AGENTS.md", ".review-input-run/source-0.txt", "standard:", "spec:AGENTS.md", "x standard:AGENTS.md"]) expect(pattern.test(invalid), `${field}: ${invalid}`).toBe(false);
  }
});

function standardFixture() {
  const { input, output } = fixture();
  input.sourceCatalog.push({ type: "standard", id: "AGENTS.md", content: "# 規約\n公開名valueを保つ。", hash: "agents-hash" });
  input.sources.push({ source: "standard:AGENTS.md", path: ".review-input/source-1.txt" });
  return { input, output };
}

test("型付きの規約IDで返した本文分類の出典は固定資料からhashと引用を復元する", () => {
  const { input, output } = standardFixture();
  output.requirements[0].contentAssessment = { kind: "obligation", references: [{ source: "standard:AGENTS.md", line: 2 }] };
  expect(expandReviewOutput(output, input).requirements[0].contentAssessment.references).toEqual([{ source: "standard:AGENTS.md", line: 2, hash: "agents-hash", quote: "公開名valueを保つ。" }]);
});

for (const [source, line, diagnostic] of [
  ["AGENTS.md", 2, { reason: "unknown_source", sourceForm: "id_without_type", sourceIndex: null, matchedSourceIndex: 1, lineCount: null }],
  ["standard:未登録の規約", 1, { reason: "unknown_source", sourceForm: "unknown", sourceIndex: null, matchedSourceIndex: null, lineCount: null }],
  ["standard:AGENTS.md", 3, { reason: "line_out_of_range", sourceForm: "catalog_id", sourceIndex: 1, matchedSourceIndex: 1, lineCount: 2 }],
] as const) test(`本文分類の出典の型なしID・未知ID・範囲外行を補正せず拒否する（${diagnostic.reason}/${diagnostic.sourceForm}）`, () => {
  const { input, output } = standardFixture();
  output.requirements[0].contentAssessment = { kind: "obligation", references: [{ source, line }] };
  try { expandReviewOutput(output, input); throw new Error("不正な出典が通った"); }
  catch (error) {
    expect(error).toBeInstanceOf(ReviewFailure);
    const e = error as ReviewFailure;
    expect(e.code).toBe("OUTPUT_INVALID");
    expect(e.referenceDiagnostic).toEqual({ ...diagnostic, field: "requirements[0].contentAssessment.references[0]", requirementUnitIndex: 0, line });
    if (diagnostic.sourceForm === "unknown") expect(e.message + JSON.stringify(e.referenceDiagnostic)).not.toContain("未登録の規約");
  }
});
