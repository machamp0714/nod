import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { ProjectDetail, ProjectSummary } from "../types";

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
