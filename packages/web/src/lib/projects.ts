import type { ProjectSummary } from "../api/types";
import type { ProjectTab } from "../routes/search";

export function filterProjects<T extends Pick<ProjectSummary, "status">>(projects: readonly T[], tab: ProjectTab): T[] {
  if (tab === "all") return [...projects];
  if (tab === "completed") return projects.filter((p) => p.status === "completed");
  return projects.filter((p) => p.status === "planned" || p.status === "started");
}
