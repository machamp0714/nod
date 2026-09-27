import { useDecisionCounts } from "../api/hooks/decision";
import type { View } from "../api/types";
import { VIEWS } from "../fixtures/views";

export interface SidebarData {
  counts: { inbox: number; reviews: number; triage: number };
  views: View[];
}

// 件数は D が API から読む。View は E が API（TanStack Query）に差し替える。
export function useSidebarData(): SidebarData {
  return { counts: useDecisionCounts(), views: VIEWS };
}
