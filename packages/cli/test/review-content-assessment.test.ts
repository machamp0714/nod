import { expect, test } from "bun:test";
import { contentAssessmentValid } from "../../core/src/ops/review-content-assessment";
import { requirementLinksValid } from "../../core/src/ops/review-requirement-links";
import { reviewUnits } from "../../core/src/ops/review-adjudicate";

function fixture(layout = "公開値は2を返す。\nこの機能の背景は旧版の利用状況である。") {
  const source = { type: "document", id: "requirements", hash: "fixed", content: layout };
  const units = reviewUnits([source as any]);
  const unit = units.find(u => u.requirement.includes("背景"))!;
  const obligation = units.find(u => u.requirement.includes("公開値"))!;
  const ref = (line: number) => ({ source: "document:requirements", hash: "fixed", line, quote: layout.split("\n")[line - 1] });
  const references = [...new Set([unit.reference.line, unit.context?.startLine ?? unit.reference.line])].map(ref);
  const code = { path: "public.ts", revision: "head", line: 1 };
  const finding = { axis: "spec", id: "wrong-value", decision: "required", contract: obligation.reference, location: code,
    expectedBehavior: "公開値は2を返す", failure: "公開値が3になる" };
  const row: any = { status: "context", findingIds: [], findingLinks: [], contentAssessment: {
    kind: "background", obligations: [], rationale: "背景の説明で実装への義務は含まない", references,
  } };
  const explored = structuredClone(row);
  row.findingLinks = [{ findingAxis: "spec", findingId: finding.id, relation: "rejected", observedBehavior: finding.failure,
    requirementEvidence: [...new Map([...references, obligation.reference].map(r => [r.line, r])).values()], codeEvidence: [structuredClone(code)],
    operation: { requirement: "過去の移行経緯の説明", candidate: "公開値の取得", match: "different" },
    condition: { requirement: "過去の経緯を記述する時点", candidate: "現在の値を取得する時点", match: "different" },
    obligation: { requirement: "背景の説明で追加の実装義務はない", candidate: finding.expectedBehavior, match: "different" },
    effectOfFix: "unchanged", rationale: "値を直しても過去の背景説明の意味は変わらない" }];
  const referenceValid = (r: any) => r?.source === "document:requirements" && r.hash === "fixed" && layout.split("\n")[r.line - 1] === r.quote;
  const locationValid = (r: any) => r?.path === code.path && r.revision === code.revision && r.line === code.line;
  const findings: any[] = [finding];
  const valid = () => {
    const linksValid = requirementLinksValid(row, unit, findings, referenceValid, locationValid, true);
    return contentAssessmentValid(row, explored, unit, findings, referenceValid, false, linksValid);
  };
  return { row, explored, unit, finding, findings, valid, ref, obligation };
}

for (const layout of ["公開値は2を返す。\nこの機能の背景は旧版の利用状況である。", "公開値は2を返す。\n\nこの機能の背景は旧版の利用状況である。", "- 公開値は2を返す。\n- この機能の背景は旧版の利用状況である。", "| 公開値は2を返す。 |\n| この機能の背景は旧版の利用状況である。 |"])
  test(`要求違反と独立した背景は文書配置だけで未確認にしない：${JSON.stringify(layout)}`, () => {
    expect(fixture(layout).valid()).toBe(true);
  });

for (const mode of ["missing", "same", "unknown", "resolves", "missing_contract_reference", "bad_reference", "bad_code", "duplicate", "wrong_axis", "same_line", "unverified_finding", "erased_obligation", "different_classification", "second_unexplained"])
  test(`段落内の要求を説明扱いで隠す不完全な対応は拒否する：${mode}`, () => {
    const f = fixture(mode === "missing_contract_reference" ? "導入当時は利用者が少なかった。\n公開値は2を返す。\nこの機能の背景は旧版の利用状況である。" : undefined), link = f.row.findingLinks[0];
    if (mode === "missing") f.row.findingLinks = [];
    if (mode === "same") for (const key of ["operation", "condition", "obligation"]) link[key].match = "same";
    if (mode === "unknown") link.condition.match = "unknown";
    if (mode === "resolves") link.effectOfFix = "resolves_this_violation";
    if (mode === "missing_contract_reference") {
      // 候補の契約が段落先頭とは別行の場合も、実際の契約への参照を要求する。
      link.requirementEvidence = link.requirementEvidence.filter((ref: any) => ref.line !== f.obligation.reference.line);
    }
    if (mode === "bad_reference") link.requirementEvidence[0].hash = "stale";
    if (mode === "bad_code") link.codeEvidence[0].path = "unrelated.ts";
    if (mode === "duplicate") f.row.findingLinks.push(structuredClone(link));
    if (mode === "wrong_axis") link.findingAxis = "standards";
    if (mode === "same_line") f.finding.contract = f.unit.reference;
    if (mode === "unverified_finding") f.finding.decision = "unverified";
    if (mode === "erased_obligation") { f.explored.contentAssessment.kind = "mixed"; f.explored.contentAssessment.obligations = ["公開値は2を返す。"]; }
    if (mode === "different_classification") f.explored.contentAssessment.kind = "scope";
    if (mode === "second_unexplained") f.findings.push({ ...f.finding, axis: "standards" });
    expect(f.valid()).toBe(false);
  });

test("同じ段落の両軸の違反を別々に照合しても候補自体を棄却しない", () => {
  const f = fixture();
  f.findings.push({ ...f.finding, axis: "standards" });
  f.row.findingLinks.push({ ...structuredClone(f.row.findingLinks[0]), findingAxis: "standards" });
  expect(f.valid()).toBe(true);
  expect(f.findings.map(finding => finding.decision)).toEqual(["required", "required"]);
});

test("前行の条件を含む義務を検証で背景へ変更すると未確認を維持する", () => {
  const f = fixture("公開値は管理者にだけ2を返す。\nこの背景条件は匿名利用者には適用しない。");
  f.explored.contentAssessment = { ...f.explored.contentAssessment, kind: "mixed", obligations: [f.unit.requirement] };
  expect(f.valid()).toBe(false);
});
