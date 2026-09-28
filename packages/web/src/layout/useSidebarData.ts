import { useViews } from "../api/hooks/views";
import type { View } from "../api/types";
import { INBOX, TRIAGE_ISSUES } from "../fixtures/inbox";

export interface SidebarData {
  counts: { inbox: number; reviews: number; triage: number };
  views: View[];
}

// View は E が API に差し替えた。件数は D が API に差し替えるまでダミーデータのまま。
export function useSidebarData(): SidebarData {
  const views = useViews();
  return {
    counts: { inbox: INBOX.questions.length, reviews: INBOX.reviews.length, triage: TRIAGE_ISSUES.length },
    views: views.data ?? [],
  };
}
