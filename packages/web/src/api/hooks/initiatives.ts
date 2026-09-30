import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { Initiative, InitiativeDetail, InitiativeSummary, UpdateInitiativeInput } from "../types";
import { useApiMutation } from "./shared";

// Initiatives のタブ（Active、Completed、All）を画面で切り替えるため、完了と中止も読む
export function useInitiatives() {
  return useQuery({
    queryKey: queryKeys.initiativeList(),
    queryFn: () => apiFetch<InitiativeSummary[]>("/initiatives?includeClosed=true"),
  });
}

// 存在を一覧で確かめてから呼ぶ（404 をコンソールに出さないため）
export function useInitiative(id: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.initiative(id),
    queryFn: () => apiFetch<InitiativeDetail>(`/initiatives/${id}`),
    enabled,
  });
}

export function useCreateInitiative() {
  return useApiMutation<{ name: string; description?: string; targetDate?: string }, Initiative>((body) =>
    apiFetch<Initiative>("/initiatives", { method: "POST", body }),
  );
}

export function useUpdateInitiative(id: number) {
  return useApiMutation<UpdateInitiativeInput, Initiative>((body) =>
    apiFetch<Initiative>(`/initiatives/${id}/update`, { method: "POST", body }),
  );
}

export function useAddInitiativeProject(id: number) {
  return useApiMutation<{ project: string }, InitiativeDetail>((body) =>
    apiFetch<InitiativeDetail>(`/initiatives/${id}/projects`, { method: "POST", body }),
  );
}

export function useRemoveInitiativeProject(id: number) {
  return useApiMutation<{ project: string }, InitiativeDetail>(({ project }) =>
    apiFetch<InitiativeDetail>(`/initiatives/${id}/projects/${encodeURIComponent(project)}`, { method: "DELETE" }),
  );
}
