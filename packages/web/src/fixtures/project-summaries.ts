import type { Project, ProjectSummary } from "../api/types";
import { ISSUES } from "./issues";
import { PROJECT_RECORDS } from "./projects";

function summarize(project: Project): ProjectSummary {
  const issues = ISSUES.filter((i) => i.project?.id === project.id);
  const count = (state: string) => issues.filter((i) => i.agentState === state).length;
  return {
    ...project,
    total: issues.length,
    done: issues.filter((i) => i.status === "done").length,
    agents: { working: count("working"), awaitingInput: count("awaiting_input"), error: count("error") },
    workspaces: [...new Set(issues.map((i) => i.workspace))],
  };
}

export const PROJECTS: ProjectSummary[] = PROJECT_RECORDS.map(summarize);

export function findProject(id: number): ProjectSummary | undefined {
  return PROJECTS.find((p) => p.id === id);
}
