import type { Issue, ProjectSummary } from "../api/types";
import type { ProjectTab } from "../routes/search";

export function filterProjects<T extends Pick<ProjectSummary, "status">>(projects: readonly T[], tab: ProjectTab): T[] {
  if (tab === "all") return [...projects];
  if (tab === "completed") return projects.filter((p) => p.status === "completed");
  return projects.filter((p) => p.status === "planned" || p.status === "started");
}


// core の ProjectSummary は Workspace を持たないため、web の側で Issue から集めて足す（Projects の一覧の Workspace の列）
export interface ProjectListItem extends ProjectSummary {
  workspaces: string[];
}

export function withWorkspaces(
  projects: readonly ProjectSummary[],
  issues: readonly Pick<Issue, "workspace" | "project">[],
): ProjectListItem[] {
  const keys = new Map<number, Set<string>>();
  for (const issue of issues) {
    if (!issue.project) continue;
    const set = keys.get(issue.project.id) ?? new Set<string>();
    set.add(issue.workspace);
    keys.set(issue.project.id, set);
  }
  return projects.map((project) => ({ ...project, workspaces: [...(keys.get(project.id) ?? [])].sort() }));
}
