import type { InitiativeStatus } from "../api/types";
import type { IconName } from "../components/ui";

// Pencil「Initiatives｜一覧」の表記。値は Project と同じ4状態で、started を Active と表す
export const INITIATIVE_STATUS_META: Record<InitiativeStatus, { label: string; icon: IconName; color: string }> = {
  planned: { label: "Planned", icon: "circle-dashed", color: "var(--ink3)" },
  started: { label: "Active", icon: "circle-dot", color: "var(--accent)" },
  completed: { label: "Completed", icon: "circle-check", color: "var(--ready)" },
  canceled: { label: "Canceled", icon: "circle-x", color: "var(--ink3)" },
};

export const INITIATIVE_STATUSES: readonly InitiativeStatus[] = ["planned", "started", "completed", "canceled"];
