import { expect, test } from "bun:test";
import { exactSdkVersionQuoted } from "../../core/src/ops/review-sdk-evidence";
import { reviewUnits } from "../../core/src/ops/review-adjudicate";
import { expandReviewOutput } from "../../core/src/ops/review-contract";
import type { ReviewSource } from "../../core/src/ops/review-prepare";

for (const [version, quote, accepted] of [
  ["1.2.3", '"tool": ["tool@1.2.3", "", {}]', true],
  ["tool@1.2.3", '"tool": ["tool@1.2.3", "", {}]', true],
  ["1.2.3", 'version = "1.2.3"', true],
  ["1.2.3", "version: 1.2.3", true],
  ["1.2.3-beta.1+build.7", 'version = "1.2.3-beta.1+build.7"', true],
  ["1.2.3", '"tool": "^1.2.3"', false],
  ["^1.2.3", '"tool": "^1.2.3"', false],
  ["~1.2.3", '"tool": "~1.2.3"', false],
  [">=1.2.3", '"tool": ">=1.2.3"', false],
  ["1.2.x", '"tool": "1.2.x"', false],
  ["latest", '"tool": "latest"', false],
  ["1.2.3", '"tool": "1.2.3 - 2.0.0"', false],
  ["1.2.3", '"tool": "1.2.3 || 2.0.0"', false],
  ["1.2.3", '"tool": "1.2.30"', false],
  ["1.2.3", '"tool": "1.2.3-beta.1"', false],
  ["1.2.3", 'tool@^1.2.3:', false],
  ["tool@1.2.3 / other@4.5.6", '"tool@1.2.3"', false],
] as const) test(`依存実版を範囲・部分一致から区別する（${version}, ${quote}）`, () => {
  expect(exactSdkVersionQuoted(version, quote)).toBe(accepted);
});

function source(content: string, extra: Partial<ReviewSource> = {}): ReviewSource {
  return { type: "document", id: "requirements.md", title: "要求", content, hash: "fixed-source", version: "fixed", sections: [], ...extra };
}

test("折り返し前の条件を文脈に保ち、行IDと要求本文と適用範囲は変えない", () => {
  const input = source("# 保存時\n保存時は入力を検証し、\n不正なら拒否する。\n\n# 読取時\n値を表示する。", { type: "standard", applicability: [
    { start: 1, end: 2, kind: "reference", rationale: "前提の参照" },
    { start: 3, end: 3, kind: "required", rationale: "必須要求" },
    { start: 4, end: 6, kind: "reference", rationale: "別の操作" },
  ] });
  const units = reviewUnits([input]);
  expect(units).toHaveLength(1);
  expect(units[0]).toMatchObject({ id: "standard:requirements.md:L3", requirement: "不正なら拒否する。", reference: { line: 3, quote: "不正なら拒否する。" }, context: {
    source: "standard:requirements.md", hash: "fixed-source", startLine: 2, endLine: 3, content: "保存時は入力を検証し、\n不正なら拒否する。",
  } });
});

test("別の箇条書きや見出しの要求を同一段落へ混ぜない", () => {
  const units = reviewUnits([source("- 登録時は\n  通知する。\n- 削除時は通知しない。\n# 設定\n値を保存する。")]);
  expect(units.map(u=>u.reference.line)).toEqual([1,2,3,5]);
  expect(units[1]?.context?.content).toBe("- 登録時は\n  通知する。");
  expect(units[2]?.context).toBeUndefined();
  expect(units[3]?.context).toBeUndefined();
});

test("構造化出力の展開はモデルの文脈を書き込まず固定入力を保持する", () => {
  const fixed = source("登録時は、\n通知する。");
  const units = reviewUnits([fixed]);
  const output = expandReviewOutput({ format: 2, target: "target", candidates: [], causeGroups: [], requirements: [{ id: units[1]!.id, context: { content: "削除時に通知する" }, status: "satisfied", implementation: [], scopeEvidence: null }] }, { target: { hash: "target" }, phase: "spec", assignedRequirementIds: units.map(u => u.id), unitCatalog: units, sourceCatalog: [fixed] });
  expect(output.requirements[0].context).toEqual(units[1]!.context);
});



// 操作名には依存せず、対応記録の整合性を検証する。
import { requirementLinksValid } from "../../core/src/ops/review-requirement-links";

function linkFixture() {
  const unit = reviewUnits([source("保存時は、\n通知する。")])[1]!;
  const location = { path: "save.ts", revision: "head", line: 1 };
  const findings = [{ id: "notify", axis: "spec", decision: "required", location }];
  const link = { findingId: "notify", requirementEvidence: [unit.reference, { ...unit.reference, line: 1, quote: "保存時は、" }], codeEvidence: [location],
    operation: { requirement: "保存する", candidate: "保存する", match: "same" }, condition: { requirement: "保存完了時", candidate: "保存完了時", match: "same" },
    obligation: { requirement: "通知する", candidate: "通知する", match: "same" }, effectOfFix: "resolves_this_violation", rationale: "保存完了の経路で通知漏れを直すと、この要求の通知違反が解消する" };
  const row = { status: "unsatisfied", findingIds: ["notify"], findingLinks: [link] };
  const valid = () => requirementLinksValid(row, unit, findings, ref => [1, 2].includes((ref as any).line), ref => (ref as any).path === "save.ts");
  return { row, link, unit, findings, valid };
}

test("別操作への棄却した対応は保存でき、候補自体の判定は変えない", () => {
  const f = linkFixture();
  f.link.operation.candidate = "削除する"; f.link.operation.match = "different"; f.link.effectOfFix = "unchanged";
  expect(f.valid()).toBe(false);
  f.row.findingIds = [];
  expect(f.valid()).toBe(true);
  expect(f.findings[0]!.decision).toBe("required");
});

test("折り返し前の操作の出典がない対応を拒否する", () => {
  const f = linkFixture();
  expect(f.valid()).toBe(true);
  f.link.requirementEvidence = [f.unit.reference];
  expect(f.valid()).toBe(false);
});

for (const mode of ["unknown_id", "other_axis", "omitted_link", "duplicate_id", "unknown_match", "empty_reason"] as const) test(`不明・欠落した対応を充足の根拠にしない（${mode}）`, () => {
  const f = linkFixture();
  if (mode === "unknown_id") f.link.findingId = "absent";
  if (mode === "other_axis") f.findings[0]!.axis = "standards";
  if (mode === "omitted_link") f.row.findingIds = [];
  if (mode === "duplicate_id") f.row.findingIds.push("notify");
  if (mode === "unknown_match") f.link.condition.match = "unknown";
  if (mode === "empty_reason") f.link.rationale = "";
  expect(f.valid()).toBe(false);
});

test("複合要求の別の違反が残っても、該当違反を直す対応は保持する", () => {
  const f = linkFixture();
  f.unit.requirement = "通知して監査記録を残す。";
  f.link.rationale = "通知漏れの修正で通知違反が解消する。監査記録の独立した違反は別候補に残る。";
  expect(f.valid()).toBe(true);
});


test("未充足の複合要求は対象外部分の一致を補足に保持し、要対応へ加えない", () => {
  const f = linkFixture();
  f.findings.push({ ...f.findings[0]!, id: "existing", decision: "out_of_scope" });
  f.row.findingLinks.push({ ...f.link, findingId: "existing", rationale: "同じ複合要求の既存部分だが今回の対象外" });
  expect(f.valid()).toBe(true);
  expect(f.row.findingIds).toEqual(["notify"]);
  f.row.status = "satisfied";
  expect(f.valid()).toBe(false);
});

test("候補の指摘箇所以外でも候補が参照するコード根拠との対応を認める", () => {
  const f = linkFixture();
  f.findings[0]!.location = { path: "README.md", revision: "head", line: 4 };
  expect(f.valid()).toBe(false);
  Object.assign(f.findings[0]!, { responsibility: { references: [{ path: "save.ts", revision: "head", line: 1 }] } });
  expect(f.valid()).toBe(true);
  f.link.codeEvidence[0]!.line = 9;
  expect(f.valid()).toBe(false);
});


test("旧形式の候補IDに軸のような文字列があっても識別子を変更しない", () => {
  const f = linkFixture();
  f.findings[0]!.id = "standards:notify";
  f.link.findingId = "standards:notify";
  f.row.findingIds = ["standards:notify"];
  expect(f.valid()).toBe(true);
});
