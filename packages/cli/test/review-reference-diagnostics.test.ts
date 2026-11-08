import { expect, test } from "bun:test";
import { expandReviewOutput } from "../../core/src/ops/review-contract";
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
