import type { Project } from "../api/types";
import type { ProjectListItem } from "../lib/projects";
import { ISSUES } from "./issues";
import { PROJECT_RECORDS } from "./projects";

function summarize(project: Project): ProjectListItem {
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

export const PROJECTS: ProjectListItem[] = PROJECT_RECORDS.map(summarize);

export function findProject(id: number): ProjectListItem | undefined {
  return PROJECTS.find((p) => p.id === id);
}
