import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { Milestone, Project, ProjectDetail, ProjectHealth, ProjectSummary, ProjectUpdate, UpdateProjectInput } from "../types";
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

// すべての Project の Milestone（Issue 一覧の Milestone 絞り込みと Issue 詳細の選択肢）
export function useMilestones() {
  return useQuery({ queryKey: queryKeys.milestones(), queryFn: () => apiFetch<Milestone[]>("/milestones") });
}

export interface MilestoneInput {
  name: string;
  targetDate: string | null;
  description: string | null;
}

export function useCreateMilestone(projectId: number) {
  return useApiMutation<MilestoneInput, Milestone>((body) =>
    apiFetch<Milestone>(`/projects/${projectId}/milestones`, { method: "POST", body }),
  );
}

export function useUpdateMilestone() {
  return useApiMutation<{ id: number } & MilestoneInput, Milestone>(({ id, ...body }) =>
    apiFetch<Milestone>(`/milestones/${id}/update`, { method: "POST", body }),
  );
}

export function useDeleteMilestone() {
  return useApiMutation<number, { id: number }>((id) => apiFetch<{ id: number }>(`/milestones/${id}`, { method: "DELETE" }));
}
