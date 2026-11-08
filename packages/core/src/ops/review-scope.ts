import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReviewSource } from "./review-prepare";
import { ReviewFailure } from "./review-failure";
import { sensitiveReviewPath } from "./review-snapshot";

export interface StandardRange { start: number; end: number; kind: "required" | "reference" | "unresolved"; rationale: string }
export interface StandardScope { path: string; hash: string; standards: { source: string; hash: string; ranges: StandardRange[] }[] }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function content(path: string): string {
  if (sensitiveReviewPath(path) || !lstatSync(path).isFile() || lstatSync(path).size > 2 * 1024 * 1024) throw new ReviewFailure("SCOPE_PLAN_INVALID", "規約適用計画は2MiB以下の通常JSONファイルで指定してください");
  return readFileSync(path, "utf8");
}
export function readStandardScope(path: string, sources: ReviewSource[]): StandardScope {
  try {
    path = resolve(path);
    const body = content(path), data = JSON.parse(body);
    if (data.version !== 1 || !Array.isArray(data.standards)) throw new Error();
    const standards = sources.filter(s => s.type === "standard"), seen = new Set<string>();
    for (const row of data.standards) {
      const source = standards.find(s => `standard:${s.id}` === row.source);
      if (!source || seen.has(row.source) || source.hash !== row.hash || !Array.isArray(row.ranges) || !row.ranges.length) throw new Error();
      seen.add(row.source);
      let next = 1;
      for (const range of row.ranges) {
        if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start !== next || range.end < range.start || !["required", "reference", "unresolved"].includes(range.kind) || typeof range.rationale !== "string" || !range.rationale.trim()) throw new Error();
        if (range.kind === "unresolved") throw new ReviewFailure("SCOPE_UNVERIFIED", "適用が未確認の規約があります");
        next = range.end + 1;
      }
      if (next !== source.content.split("\n").length + 1) throw new Error();
    }
    if (seen.size !== standards.length) throw new Error();
    for (const row of data.standards) standards.find(s => `standard:${s.id}` === row.source)!.applicability = row.ranges;
    return { path, hash: digest(body), standards: data.standards };
  } catch (error) {
    if (error instanceof ReviewFailure) throw error;
    throw new ReviewFailure("SCOPE_PLAN_INVALID", "規約適用計画のsource・hash・全行範囲・判断根拠が一致しません。Issue・Specは除外できません");
  }
}
export function verifyStandardScope(scope?: StandardScope): string | undefined {
  if (!scope) return;
  try {
    if (digest(content(scope.path)) === scope.hash) return scope.hash;
  } catch { /* 元の確認条件が変わった場合は成功にしない。 */ }
  throw new ReviewFailure("REQUIREMENTS_CHANGED", "固定した規約適用計画が変更されました。新しい実行が必要です");
}
