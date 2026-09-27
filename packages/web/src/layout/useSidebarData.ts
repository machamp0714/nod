import type { View } from "../api/types";
import { INBOX, TRIAGE_ISSUES } from "../fixtures/inbox";
import { VIEWS } from "../fixtures/views";

export interface SidebarData {
  counts: { inbox: number; reviews: number; triage: number };
  views: View[];
}

// A はダミーデータを返す。D が件数を、E が View を API（TanStack Query）に差し替える。
export function useSidebarData(): SidebarData {
  return {
    counts: { inbox: INBOX.questions.length, reviews: INBOX.reviews.length, triage: TRIAGE_ISSUES.length },
    views: VIEWS,
  };
}
