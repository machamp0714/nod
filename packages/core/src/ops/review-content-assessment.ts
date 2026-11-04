import type { ReviewUnit } from "./review-adjudicate";

type Row = Record<string, any>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const contextKinds = ["background", "rationale", "scope", "validation_gap"];

/** 本文は削除せず、分類の出典・独立確認・既知の矛盾を照合する。意味の正しさはモデルの確認が必要。 */
export function contentAssessmentValid(row: Row, explored: Row, unit: ReviewUnit, findings: Row[], referenceValid: (ref: unknown) => boolean, automatic: boolean, linksValid = false): boolean {
  const check = (value: unknown) => {
    const a = object(value), refs = a.references, obligations = a.obligations;
    const content = unit.context?.content ?? unit.requirement;
    const hasLine = (line: number) => Array.isArray(refs) && refs.some(ref => object(ref).source === unit.reference.source && object(ref).line === line);
    return [...contextKinds, "obligation", "mixed", "independent_check", "unknown"].includes(a.kind)
      && text(a.rationale) && Array.isArray(refs) && refs.length > 0 && refs.every((ref: unknown) => referenceValid(ref))
      && hasLine(unit.reference.line) && (!unit.context || hasLine(unit.context.startLine))
      && Array.isArray(obligations) && new Set(obligations).size === obligations.length
      && obligations.every(part => text(part) && content.includes(part))
      && (["obligation", "mixed"].includes(a.kind) ? obligations.length > 0 : obligations.length === 0);
  };
  const a = object(row.contentAssessment), before = object(explored.contentAssessment);
  if (!check(a) || !check(before) || a.kind === "unknown") return false;
  // 探索が挙げた義務を、検証で説明や別の短い引用へ置き換えて消さない。
  if (before.kind === "unknown" || (before.obligations as string[]).some(part => !(a.obligations as string[]).includes(part))) return false;
  if (contextKinds.includes(a.kind)) {
    const start = unit.context?.startLine ?? unit.reference.line, end = unit.context?.endLine ?? unit.reference.line;
    const conflict = findings.some(f => {
      const contract = object(f.contract);
      if (!["required", "unverified"].includes(f.decision) || contract.source !== unit.reference.source || contract.line < start || contract.line > end) return false;
      // 同じ行の違反や未確認候補は説明へ退避しない。別行でも、段落が同じというだけでは切り離さない。
      if (contract.line === unit.reference.line || f.decision !== "required" || !linksValid) return true;
      const links = Array.isArray(row.findingLinks) ? row.findingLinks : [];
      const rejected = links.filter(link => link.findingAxis === f.axis && link.findingId === f.id && link.relation === "rejected");
      // 対応検査済みの記録に実際の契約出典と相違があれば、候補は保持したまま説明行との対応だけを退ける。
      return rejected.length !== 1 || !["operation", "condition", "obligation"].some(key => object(rejected[0][key]).match === "different")
        || rejected[0].effectOfFix !== "unchanged"
        || !rejected[0].requirementEvidence.some((ref: Row) => ref.source === contract.source && ref.line === contract.line);
    });
    return !automatic && before.kind === a.kind && explored.status === "context" && row.status === "context"
      && Array.isArray(row.findingIds) && row.findingIds.length === 0 && !conflict;
  }
  if (a.kind === "independent_check") return automatic && before.kind === a.kind && row.status === "out_of_scope" && explored.status === "out_of_scope";
  return !automatic && row.status !== "context";
}
