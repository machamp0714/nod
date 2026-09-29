import { useDecisionCounts } from "../api/hooks/decision";
import { useWorkspaces } from "../api/hooks/shared";
import { useViews } from "../api/hooks/views";
import type { View, Workspace } from "../api/types";

export interface SidebarData {
  counts: { inbox: number; reviews: number; triage: number };
  views: View[];
  viewsReady: boolean;
  workspaces: Workspace[];
}

// 件数は D が、View は E が API から読む。Workspace は設定への導線に使う
export function useSidebarData(): SidebarData {
  const views = useViews();
  const workspaces = useWorkspaces();
  return {
    counts: useDecisionCounts(),
    views: views.data ?? [],
    viewsReady: views.data !== undefined && !views.isError,
    workspaces: workspaces.data ?? [],
  };
}
