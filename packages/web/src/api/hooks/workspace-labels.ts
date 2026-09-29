import { useQuery } from "@tanstack/react-query";
import type { StatusNames, StatusNamesByWorkspace } from "../../lib/workspace-labels";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { WorkspaceLabel } from "../types";
import { useApiMutation } from "./shared";

function labelsPath(key: string, op?: string): string {
  return `/workspaces/${encodeURIComponent(key)}/labels${op ? `/${op}` : ""}`;
}

export function useWorkspaceLabels(key: string, enabled = true) {
  return useQuery({ queryKey: queryKeys.workspaceLabels(key), queryFn: () => apiFetch<WorkspaceLabel[]>(labelsPath(key)), enabled });
}

export function useAddWorkspaceLabel(key: string) {
  return useApiMutation((input: { name: string; color: string; description: string }) =>
    apiFetch<WorkspaceLabel>(labelsPath(key), { method: "POST", body: input }),
  );
}

export function useUpdateWorkspaceLabel(key: string) {
  return useApiMutation((input: { name: string; newName: string; color: string; description: string }) =>
    apiFetch<WorkspaceLabel>(labelsPath(key, "update"), { method: "POST", body: input }),
  );
}

export function useRemoveWorkspaceLabel(key: string) {
  return useApiMutation((name: string) =>
    apiFetch<{ workspaceKey: string; name: string; removed: true }>(labelsPath(key, "remove"), { method: "POST", body: { name } }),
  );
}

// 全 Workspace の表示名。ステータスを出す画面が共有する
export function useStatusNames() {
  return useQuery({ queryKey: queryKeys.statusNames(), queryFn: () => apiFetch<StatusNamesByWorkspace>("/status-names") });
}

export function useSaveStatusNames(key: string) {
  return useApiMutation((names: StatusNames) =>
    apiFetch<{ workspaceKey: string; names: StatusNames }>(`/workspaces/${encodeURIComponent(key)}/status-names`, {
      method: "PUT",
      body: { names },
    }),
  );
}
