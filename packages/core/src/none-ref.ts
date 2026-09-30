// 絞り込みで「Milestone のない」「Cycle のない」Issue を指す値。Issue 一覧・分析（stats・stats llm）・要約・API で同じく扱い、
// 大文字小文字と前後の空白は問わない。Milestone・Cycle の名前には使えない
export const NONE_REF = "none";

export function isNoneRef(ref: string | undefined): boolean {
  return ref !== undefined && ref.trim().toLowerCase() === NONE_REF;
}
