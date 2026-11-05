import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { reviewUnits } from "./review-adjudicate";
import type { ReviewSource } from "./review-prepare";
import { ReviewFailure } from "./review-process";
import { sensitiveReviewPath } from "./review-snapshot";

export interface ReviewResponsibility {
  path: string; hash: string;
  assignments: { sourceHash: string; line: number; owner: "automatic_check"; rationale: string }[];
}
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
function read(path: string): string {
  if (sensitiveReviewPath(path) || !lstatSync(path).isFile() || lstatSync(path).size > 2 * 1024 * 1024) throw new Error();
  return readFileSync(path, "utf8");
}
/** 自動チェックの結果ではなく、要求から事前に決めた責務だけを固定する。 */
export function readReviewResponsibility(path: string, sources: ReviewSource[]): ReviewResponsibility {
  try {
    path = resolve(path);
    const body = read(path), data = JSON.parse(body), units = reviewUnits(sources), seen = new Set<string>();
    if (data.version !== 1 || Object.keys(data).some(k => !["version", "assignments"].includes(k)) || !Array.isArray(data.assignments)) throw new Error();
    for (const row of data.assignments) {
      const key = `${row.sourceHash}:${row.line}`;
      if (!row || Object.keys(row).some(k => !["sourceHash", "line", "owner", "rationale"].includes(k))
        || seen.has(key) || row.owner !== "automatic_check" || typeof row.rationale !== "string" || !row.rationale.trim()
        || !Number.isInteger(row.line) || !units.some(u => u.reference.hash === row.sourceHash && u.reference.line === row.line)) throw new Error();
      seen.add(key);
    }
    return { path, hash: digest(body), assignments: data.assignments };
  } catch { throw new ReviewFailure("RESPONSIBILITY_INVALID", "責務計画の固定資料hash・行・担当・理由が不正です。結果や診断を含めず、機械的な合否だけの要求を指定してください"); }
}
export function verifyReviewResponsibility(plan?: ReviewResponsibility): string | undefined {
  if (!plan) return;
  try { if (digest(read(plan.path)) === plan.hash) return plan.hash; } catch { /* 変更・取得不能を成功にしない。 */ }
  throw new ReviewFailure("REQUIREMENTS_CHANGED", "固定した責務計画が変更されました。新しい実行が必要です");
}
