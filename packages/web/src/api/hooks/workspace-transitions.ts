import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { Status, TransitionPreset, WorkspaceTransitionRules } from "../types";
import { useApiMutation } from "./shared";

// ステータスの遷移ルール（#73）
function transitionsPath(key: string): string {
  return `/workspaces/${encodeURIComponent(key)}/transitions`;
}

export function useTransitionRules(key: string) {
  return useQuery({ queryKey: queryKeys.transitionRules(key), queryFn: () => apiFetch<WorkspaceTransitionRules>(transitionsPath(key)) });
}

export function useSaveTransitionRules(key: string) {
  return useApiMutation((input: { forbidden: { from: Status; to: Status }[]; presets: TransitionPreset[] }) =>
    apiFetch<WorkspaceTransitionRules>(transitionsPath(key), { method: "PUT", body: input }),
  );
}
