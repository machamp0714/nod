import type { Relations, RelationState } from "../api/types";

// 関連 Issue の相手に添える印（design/nod.pen「12 Issue 詳細｜関係の状態」）。CLI の nod issue show と同じ規則（#176・#203）。
// アーカイブ済みはどの関係でも添える。Blocked by は「着手できる」の判定で数えない理由（完了・キャンセル）も添える
export function relationMark(key: keyof Relations, state: RelationState | undefined): string | null {
  if (!state) return null;
  if (state.archived) return "アーカイブ済み";
  if (key !== "blockedBy") return null;
  if (state.status === "done") return "完了";
  if (state.status === "canceled") return "キャンセル";
  return null;
}
