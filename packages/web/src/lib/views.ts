import type { View } from "../api/types";

// View の色の選択肢。値は tokens.css の --ws-a〜--ws-d と --accent の値（View の color は DB に値で保存するため）
export const VIEW_COLORS = [
  { value: "#7C5CFF", label: "紫" },
  { value: "#0E9F6E", label: "緑" },
  { value: "#D97706", label: "橙" },
  { value: "#DB2777", label: "桃" },
  { value: "#3F51D8", label: "青" },
] as const;

// server の VIEW_EXISTS（409）を画面から起こさないため、保存の前にダイアログで確かめる
export function viewNameError(name: string, views: readonly Pick<View, "id" | "name">[] | undefined, selfId: number | null): string | null {
  if (views === undefined) return "View の一覧を確認できるまでお待ちください";
  const trimmed = name.trim();
  if (trimmed === "") return "名前を入力してください";
  if (views.some((v) => v.name === trimmed && v.id !== selfId)) return `View「${trimmed}」はすでにあります`;
  return null;
}
