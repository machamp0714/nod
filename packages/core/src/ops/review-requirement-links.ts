import type { ReviewUnit } from "./review-adjudicate";

type Row = Record<string, any>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => typeof value === "string" && value.trim().length > 0;

export function linkedFindingKeys(row: Row, axis: string, modern = false): string[] {
  return Array.isArray(row.findingIds) ? row.findingIds.filter(text).map(id => modern ? id : `${axis}:${id}`) : [];
}

/** 意味の一致そのものはモデルが確認する。ここでは対応記録の欠落・矛盾・出典を検証する。 */
export function requirementLinksValid(row: Row, unit: ReviewUnit, findings: Row[], referenceValid: (ref: unknown) => boolean, locationValid: (ref: unknown) => boolean, modern = false): boolean {
  const ids = row.findingIds ?? [];
  if (!Array.isArray(ids) || ids.some(id => !text(id)) || new Set(ids).size !== ids.length) return false;
  if (modern && ids.some(id => !/^(standards|spec):.+/.test(id))) return false;
  const used = linkedFindingKeys(row, unit.axis, modern);
  if (new Set(used).size !== used.length) return false;
  if (!ids.length && row.findingLinks === undefined) return !modern;
  if (!Array.isArray(row.findingLinks)) return false;
  const seen = new Set<string>();
  for (const value of row.findingLinks) {
    const link = object(value);
    const axis = modern ? link.findingAxis : unit.axis;
    const key = `${axis}:${link.findingId}`;
    const candidates = findings.filter(f => f.axis === axis && f.id === link.findingId);
    const candidate = candidates[0];
    if (!text(link.findingId) || !["standards", "spec"].includes(axis) || seen.has(key) || candidates.length !== 1 || !candidate) return false;
    seen.add(key);
    const refs = link.requirementEvidence;
    const hasLine = (line: number) => Array.isArray(refs) && refs.some(ref => object(ref).source === unit.reference.source && object(ref).line === line);
    if (!Array.isArray(refs) || !refs.length || !refs.every(ref => referenceValid(ref)) || !hasLine(unit.reference.line)
      || (unit.context && !hasLine(unit.context.startLine))) return false;
    const code = link.codeEvidence;
    const anchors = [candidate.location, ...(Array.isArray(object(candidate.responsibility).references) ? candidate.responsibility.references : [])].map(object);
    if (!Array.isArray(code) || !code.length || !code.every(locationValid)
      || !code.some(ref => { const r = object(ref); return anchors.some(anchor => r.path === anchor.path && r.revision === anchor.revision && r.line === anchor.line); })) return false;
    const checks = [link.operation, link.condition, link.obligation].map(object);
    if (!checks.every(check => text(check.requirement) && text(check.candidate) && ["same", "different", "unknown"].includes(check.match))
      || !text(link.rationale) || !["resolves_this_violation", "unchanged", "unknown"].includes(link.effectOfFix)) return false;
    const matched = checks.every(check => check.match === "same") && link.effectOfFix === "resolves_this_violation";
    if (modern) {
      // 期待動作を誤動作で代用しない。言い換えの意味判断自体はモデルの責任。
      if (!text(candidate.expectedBehavior) || candidate.expectedBehavior.trim() === String(candidate.failure).trim()
        || object(link.obligation).candidate !== candidate.expectedBehavior || link.observedBehavior !== candidate.failure) return false;
      if (link.relation === "violation") {
        if (!used.includes(key) || !matched || !["required", "out_of_scope", "unverified"].includes(candidate.decision)) return false;
      } else {
        if (used.includes(key)) return false;
        if (link.relation === "supporting") {
          const duplicateCause = candidate.decision === "required" && text(candidate.rootCause) && findings.some(f =>
            used.includes(`${f.axis}:${f.id}`) && f.decision === "required" && f.rootCause === candidate.rootCause);
          if (!matched || row.status !== "unsatisfied" || !(candidate.decision === "out_of_scope" || duplicateCause)) return false;
        } else if (link.relation === "rejected") {
          if (checks.some(check => check.match === "unknown") || link.effectOfFix !== "unchanged") return false;
        } else if (link.relation === "unresolved") {
          if (row.status !== "unverified" || (!checks.some(check => check.match === "unknown") && link.effectOfFix !== "unknown")) return false;
        } else return false;
      }
    } else if (ids.includes(link.findingId)) {
      if (!matched || !["required", "out_of_scope", "unverified"].includes(candidate.decision)) return false;
    } else {
      // 未充足の複合要求では、対象外部分との対応を採点に使わず補足として残せる。
      const ancillaryOutside = row.status === "unsatisfied" && candidate.decision === "out_of_scope";
      if ((matched && !ancillaryOutside) || checks.some(check => check.match === "unknown") || link.effectOfFix === "unknown") return false;
    }
  }
  return used.every(id => seen.has(id));
}
