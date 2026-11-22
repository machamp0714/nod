// 絞り込みで「Milestone のない」「Sprint の関連がない」Issue を指す値。大文字小文字と前後の空白は問わない。
export const NONE_REF = "none";

export function isNoneRef(ref: string | undefined): boolean {
  return ref !== undefined && ref.trim().toLowerCase() === NONE_REF;
}
