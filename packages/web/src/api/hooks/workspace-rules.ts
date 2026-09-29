import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { WorkspaceRules } from "../types";
import { useApiMutation } from "./shared";

function rulesPath(key: string): string {
  return `/workspaces/${encodeURIComponent(key)}/rules`;
}

export function useWorkspaceRules(key: string, enabled = true) {
  return useQuery({ queryKey: queryKeys.workspaceRules(key), queryFn: () => apiFetch<WorkspaceRules | null>(rulesPath(key)), enabled });
}

export function useSaveWorkspaceRules(key: string) {
  return useApiMutation((body: string) => apiFetch<WorkspaceRules | null>(rulesPath(key), { method: "PUT", body: { body } }));
}

export function useDeleteWorkspaceRules(key: string) {
  return useApiMutation(() => apiFetch<{ workspaceKey: string; cleared: true }>(rulesPath(key), { method: "DELETE" }));
}
