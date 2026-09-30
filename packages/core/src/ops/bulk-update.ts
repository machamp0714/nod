import { isLlm, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { canonicalIssueRef, findIssueRow } from "../issue-query";
import type { Issue, Status } from "../types";
import { type UpdateIssueInput, updateIssue, validateDueDate, validateEstimate, validatePriority } from "./issues";

// 1回の一括更新で扱える Issue の上限。1トランザクションで書き込みロックを握る時間を抑える
export const BULK_UPDATE_LIMIT = 100;

export type BulkUpdateInput = Pick<
  UpdateIssueInput,
  "status" | "priority" | "assignee" | "projectRef" | "milestoneRef" | "cycleRef" | "estimate" | "dueDate" | "addLabels" | "removeLabels" | "reason"
>;

export interface BulkUpdateFailure {
  id: string;
  code: string;
  message: string;
}

function hasChange(input: BulkUpdateInput): boolean {
  const { addLabels, removeLabels, reason: _reason, ...rest } = input;
  return Object.values(rest).some((v) => v !== undefined) || !!addLabels?.length || !!removeLabels?.length;
}

// Triage の受け入れ・却下は Triage の判断として記録するため、一括の状態変更では迂回させない
function checkTriage(ctx: OpCtx, ref: string, status: Status | undefined): void {
  if (status === undefined) return;
  if (status === "triage") {
    throw new NodError("TRIAGE_DECISION_REQUIRED", "一括編集では状態を Triage に戻せません");
  }
  const row = findIssueRow(ctx.db, ref);
  if (row.status === "triage" && isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は Triage にある Issue の状態を変えられません。受け入れ・却下は me に依頼してください");
  }
  if (row.status === "triage") {
    // 失敗一覧は ID と理由を並べて出すため、理由には ID を含めない
    throw new NodError("TRIAGE_DECISION_REQUIRED", "Triage にあります。受け入れ・却下は Triage 画面で判断してください");
  }
}

// 同じ Issue を指す ID（大文字小文字・前後の空白・番号の先頭の 0 の違い）は1件にまとめ、最初の表記を残す。
// findIssueRow と同じ規則で畳むため DB を引かず、上限の判定の前に大量の照会をしない
function uniqueRefs(refs: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of refs) {
    const ref = raw.trim();
    const key = canonicalIssueRef(ref) ?? ref.toUpperCase();
    if (!seen.has(key)) seen.set(key, ref);
  }
  return [...seen.values()];
}

// 複数 Issue に同じ変更を加える。各 Issue に updateIssue の保護を1件ずつ通し、全件を1トランザクションで書く。
// 1件でも失敗したら何も書かず、失敗した全 Issue の理由を BULK_UPDATE_FAILED の details.failures で返す。
export function bulkUpdateIssues(ctx: OpCtx, refs: string[], input: BulkUpdateInput): Issue[] {
  const ids = uniqueRefs(refs);
  if (ids.length === 0) throw new NodError("INVALID_ARGS", "一括編集する Issue を1件以上指定してください");
  if (ids.length > BULK_UPDATE_LIMIT) {
    throw new NodError("INVALID_ARGS", `一括編集は1回 ${BULK_UPDATE_LIMIT} 件までです（${ids.length} 件）`);
  }
  if (!hasChange(input)) throw new NodError("INVALID_ARGS", "変更する項目を1つ以上指定してください");
  // 値そのものの誤りは Issue ごとではないため、失敗一覧にせずそのまま返す
  if (input.status === "needs_clarification") {
    throw new NodError("INVALID_ARGS", "needs_clarification は確認依頼に応じて自動で切り替わるため、手では変えられません");
  }
  if (input.priority !== undefined) validatePriority(input.priority);
  if (input.estimate != null) validateEstimate(input.estimate);
  if (input.dueDate != null) validateDueDate(input.dueDate);
  return tx(ctx.db, () => {
    const updated: Issue[] = [];
    const failures: BulkUpdateFailure[] = [];
    for (const id of ids) {
      try {
        checkTriage(ctx, id, input.status);
        updated.push(updateIssue(ctx, id, input));
      } catch (e) {
        if (!(e instanceof NodError) || e.code === "DB_BUSY") throw e;
        failures.push({ id, code: e.code, message: e.message });
      }
    }
    if (failures.length > 0) {
      throw new NodError(
        "BULK_UPDATE_FAILED",
        `${failures.length} 件を更新できなかったため、何も変更していません（${failures.map((f) => `${f.id}: ${f.message}`).join(" / ")}）`,
        { failures },
      );
    }
    return updated;
  });
}
