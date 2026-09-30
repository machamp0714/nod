import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { Project, ProjectDetail, ProjectHealth, ProjectSummary, ProjectUpdate, UpdateProjectInput } from "../types";
import { useApiMutation } from "./shared";

// Projects のタブ（Active、Completed、All）を画面で切り替えるため、完了と中止の Project も読む
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projectList({ includeClosed: true }),
    queryFn: () => apiFetch<ProjectSummary[]>("/projects?includeClosed=true"),
  });
}

// 存在を一覧で確かめてから呼ぶ（GET /api/projects/:id の 404 をコンソールに出さないため）
export function useProject(id: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.project(id),
    queryFn: () => apiFetch<ProjectDetail>(`/projects/${id}`),
    enabled,
  });
}

export function useUpdateProject(id: number) {
  return useApiMutation<UpdateProjectInput, Project>((body) =>
    apiFetch<Project>(`/projects/${id}/update`, { method: "POST", body }),
  );
}

export function useAddProjectUpdate(id: number) {
  return useApiMutation<{ body: string; health: ProjectHealth | null }, ProjectUpdate>((body) =>
    apiFetch<ProjectUpdate>(`/projects/${id}/reports`, { method: "POST", body }),
  );
}
