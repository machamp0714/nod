import { getRouteApi } from "@tanstack/react-router";
import { findProject } from "../fixtures/project-summaries";
import { NotFoundMessage } from "./NotFoundPage";

const route = getRouteApi("/projects/$projectId");

export function ProjectDetailPage() {
  const { projectId } = route.useParams();
  const project = findProject(Number(projectId));
  if (!project) return <NotFoundMessage title="Project が見つかりません" />;
  return <h1>{project.name}</h1>;
}
