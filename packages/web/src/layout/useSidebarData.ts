import { useDecisionCounts } from "../api/hooks/decision";
import { useViews } from "../api/hooks/views";
import type { View } from "../api/types";

export interface SidebarData {
  counts: { inbox: number; reviews: number; triage: number };
  views: View[];
  viewsReady: boolean;
}

// 件数は D が、View は E が API から読む。
export function useSidebarData(): SidebarData {
  const views = useViews();
  return {
    counts: useDecisionCounts(),
    views: views.data ?? [],
    viewsReady: views.data !== undefined && !views.isError,
  };
}
