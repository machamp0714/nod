import { NodError } from "./errors";

// 絞り込みで「Milestone のない」「Cycle のない」「担当のない（未割り当て）」Issue を指す値。Issue 一覧・分析（stats・stats llm）・要約・API で同じく扱い、
// 大文字小文字と前後の空白は問わない。Milestone・Cycle・担当の名前には使えない
export const NONE_REF = "none";

export function isNoneRef(ref: string | undefined): boolean {
  return ref !== undefined && ref.trim().toLowerCase() === NONE_REF;
}

// 担当は自由な文字列だが、none だけは予約する（Issue の更新・一括更新・受け入れ、定期Issue、Triage の提案で同じく拒む）。
// 担当を外すのは null（CLI は空文字）
export function validateAssignee(assignee: string | null | undefined): void {
  if (typeof assignee === "string" && isNoneRef(assignee)) {
    throw new NodError(
      "INVALID_ARGS",
      `担当の名前に ${NONE_REF} は使えません。絞り込みで未割り当ての Issue を指す値として予約しています（担当を外すには、CLI は空文字、API は null を指定してください）`,
    );
  }
}
