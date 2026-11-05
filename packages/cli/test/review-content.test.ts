import { expect, test } from "bun:test";
import { contentAssessmentValid } from "../../core/src/ops/review-content-assessment";
import { requirementLinksValid } from "../../core/src/ops/review-requirement-links";
import { reviewUnits } from "../../core/src/ops/review-adjudicate";
import type { ReviewSource } from "../../core/src/ops/review-prepare";

function contentFixture(content = "過去の調査は未完了である。") {
  const source: ReviewSource = { type: "document", id: "contract", hash: "fixed", content, title: "契約", version: "fixed", sections: [] };
  const unit = reviewUnits([source])[0]!;
  const row: any = { status: "context", findingIds: [], implementation: [], contentAssessment: {
    kind: "validation_gap", obligations: [], references: [unit.reference], rationale: "過去の検証実績の説明であり、新たな作業を命じていない",
  } };
  const explored = structuredClone(row), findings: any[] = [];
  const valid = (automatic = false) => contentAssessmentValid(row, explored, unit, findings, ref => JSON.stringify(ref) === JSON.stringify(unit.reference), automatic);
  return { row, explored, findings, unit, valid };
}

test("説明だけの確認記録は実装証拠や充足への変更を要しない", () => {
  const f = contentFixture();
  expect(f.valid()).toBe(true);
  expect(f.row.status).toBe("context");
  f.row.status = "satisfied";
  expect(f.valid()).toBe(false);
});

for (const mode of ["different_kind", "unknown", "missing_reference", "stale_reference", "missing_reason", "missing_exploration", "finding", "assignment"] as const) {
  test(`説明扱いの根拠不足や矛盾を未確認へ残す（${mode}）`, () => {
    const f = contentFixture();
    if (mode === "different_kind") f.explored.contentAssessment.kind = "scope";
    if (mode === "unknown") f.explored.contentAssessment.kind = "unknown";
    if (mode === "missing_reference") f.row.contentAssessment.references = [];
    if (mode === "stale_reference") f.row.contentAssessment.references[0].hash = "old";
    if (mode === "missing_reason") f.row.contentAssessment.rationale = "";
    if (mode === "missing_exploration") delete f.explored.contentAssessment;
    if (mode === "finding") f.findings.push({ axis: "standards", decision: "required", contract: f.unit.reference });
    expect(f.valid(mode === "assignment")).toBe(false);
  });
}

test("説明と実装義務が混在する文から義務を消せない", () => {
  const f = contentFixture("過去の調査は未完了である。保存時は通知を送る。");
  for (const row of [f.row, f.explored]) Object.assign(row, { status: "satisfied", contentAssessment: { ...row.contentAssessment, kind: "mixed", obligations: ["保存時は通知を送る。"] } });
  expect(f.valid()).toBe(true);
  f.row.contentAssessment.kind = "validation_gap"; f.row.contentAssessment.obligations = []; f.row.status = "context";
  expect(f.valid()).toBe(false);
  f.row.contentAssessment.kind = "mixed"; f.row.contentAssessment.obligations = ["通知を送る。"];
  expect(f.valid()).toBe(false);
});

test("原文にない義務を分類の根拠にせず、検証済みという説明も合格に変えない", () => {
  const f = contentFixture("過去の調査は完了した。");
  f.row.contentAssessment = { ...f.row.contentAssessment, kind: "obligation", obligations: ["全件で成功する。"] };
  expect(f.valid()).toBe(false);
});

test("独立検査は事前分担と両工程の一致を要し、意味を含む複合要求は除外しない", () => {
  const f = contentFixture("外部URLの現在の到達性を検査する。");
  for (const row of [f.row, f.explored]) { row.status = "out_of_scope"; row.contentAssessment.kind = "independent_check"; }
  expect(f.valid()).toBe(false);
  expect(f.valid(true)).toBe(true);
  f.explored.contentAssessment.kind = "mixed"; f.explored.contentAssessment.obligations = [f.unit.requirement];
  expect(f.valid(true)).toBe(false);
});

function linkFixture() {
  const f = contentFixture("保存時は通知する。");
  const location = { path: "workflow.ts", revision: "head", line: 2 };
  const candidate: any = { id: "same-id", axis: "standards", decision: "required", rootCause: "notify", location,
    expectedBehavior: "通知する", failure: "通知が送られない" };
  const other = { ...candidate, axis: "spec", decision: "false_positive", rootCause: "other" };
  const link: any = { findingAxis: "standards", findingId: "same-id", relation: "violation", observedBehavior: candidate.failure,
    requirementEvidence: [f.unit.reference], codeEvidence: [location],
    operation: { requirement: "保存", candidate: "保存", match: "same" }, condition: { requirement: "成功時", candidate: "成功時", match: "same" },
    obligation: { requirement: "通知する", candidate: "通知する", match: "same" }, effectOfFix: "resolves_this_violation", rationale: "保存成功後の通知欠落だけを直すと当該義務を満たす" };
  const row: any = { status: "unsatisfied", findingIds: ["standards:same-id"], findingLinks: [link] };
  const findings = [candidate, other];
  const valid = () => requirementLinksValid(row, f.unit, findings, ref => JSON.stringify(ref) === JSON.stringify(f.unit.reference), ref => JSON.stringify(ref) === JSON.stringify(location), true);
  return { row, candidate, other, link, findings, valid };
}

test("異なる軸の同名候補を区別して要求違反へ対応付ける", () => {
  const f = linkFixture(); expect(f.valid()).toBe(true);
  f.link.findingAxis = "spec"; expect(f.valid()).toBe(false);
});

for (const mode of ["bare_id", "duplicate", "missing_axis", "missing_link", "wrong_operation", "wrong_condition", "wrong_obligation", "wrong_effect", "wrong_reference", "wrong_code", "behavior_as_expectation", "different_failure"] as const) {
  test(`軸付きの参照でも対応の検査を緩めない（${mode}）`, () => {
    const f = linkFixture();
    if (mode === "bare_id") f.row.findingIds = ["same-id"];
    if (mode === "duplicate") f.row.findingLinks.push(structuredClone(f.link));
    if (mode === "missing_axis") delete f.link.findingAxis;
    if (mode === "missing_link") f.row.findingLinks = [];
    if (mode === "wrong_operation") f.link.operation.match = "different";
    if (mode === "wrong_condition") f.link.condition.match = "different";
    if (mode === "wrong_obligation") f.link.obligation.match = "different";
    if (mode === "wrong_effect") f.link.effectOfFix = "unchanged";
    if (mode === "wrong_reference") f.link.requirementEvidence = [];
    if (mode === "wrong_code") f.link.codeEvidence = [{ path: "other.ts", revision: "head", line: 2 }];
    if (mode === "behavior_as_expectation") f.link.obligation.candidate = f.candidate.failure;
    if (mode === "different_failure") f.link.observedBehavior = "別の障害";
    expect(f.valid()).toBe(false);
  });
}

test("同一原因の別候補は補足へ残し、異なる原因や充足の隠れた要対応には使わない", () => {
  const f = linkFixture(); f.other.decision = "required"; f.other.rootCause = "notify";
  f.row.findingLinks.push({ ...f.link, findingAxis: "spec", relation: "supporting" });
  expect(f.valid()).toBe(true);
  f.other.rootCause = "other"; expect(f.valid()).toBe(false);
  f.other.rootCause = "notify"; f.row.status = "satisfied"; expect(f.valid()).toBe(false);
});

for (const mode of ["operation", "condition", "obligation", "unknown_effect", "unchanged_effect"] as const) {
  test(`同じ原因の補足でも対応の不一致や修正効果の不足を通さない（${mode}）`, () => {
    const f = linkFixture(); f.other.decision = "required"; f.other.rootCause = f.candidate.rootCause;
    const supporting = { ...structuredClone(f.link), findingAxis: "spec", relation: "supporting" };
    f.row.findingLinks.push(supporting);
    expect(f.valid()).toBe(true);
    if (mode === "unknown_effect") supporting.effectOfFix = "unknown";
    else if (mode === "unchanged_effect") supporting.effectOfFix = "unchanged";
    else supporting[mode].match = "different";
    expect(f.valid()).toBe(false);
    expect(f.candidate.decision).toBe("required");
    expect(f.other.decision).toBe("required");
  });
}

test("同じ原因でも対応の棄却と未確認を区別し、候補自体の採否を保持する", () => {
  const f = linkFixture(); f.other.decision = "required"; f.other.rootCause = f.candidate.rootCause;
  const related = { ...structuredClone(f.link), findingAxis: "spec", relation: "rejected", effectOfFix: "unchanged" };
  related.obligation.match = "different";
  f.row.findingLinks.push(related);
  expect(f.valid()).toBe(true);
  related.effectOfFix = "unknown";
  expect(f.valid()).toBe(false);
  related.relation = "unresolved"; f.row.status = "unverified";
  expect(f.valid()).toBe(true);
  expect(f.row.findingIds).toEqual(["standards:same-id"]);
  expect(f.other.decision).toBe("required");
});

test("棄却と不明な対応を採否とは別に保持する", () => {
  const f = linkFixture(); f.row.findingIds = [];
  f.link.relation = "rejected"; f.link.operation.match = "different"; f.link.effectOfFix = "unchanged";
  expect(f.valid()).toBe(true); expect(f.candidate.decision).toBe("required");
  f.link.relation = "unresolved"; f.link.operation.match = "unknown";
  expect(f.valid()).toBe(false);
  f.row.status = "unverified"; expect(f.valid()).toBe(true);
});


for (const [kind, content] of [
  ["background", "以前の利用者は手作業で確認していた。"],
  ["rationale", "この方針は過去の調査から得た。"],
  ["scope", "今回の対象は公開契約の変更である。"],
  ["validation_gap", "古い環境での挙動は未検証である。"],
]) test(`説明の種類を保持して原文を省略しない（${kind}）`, () => {
  const f = contentFixture(content);
  f.row.contentAssessment.kind = kind; f.explored.contentAssessment.kind = kind;
  expect(f.valid()).toBe(true);
  expect(f.unit.requirement).toBe(content!);
});
