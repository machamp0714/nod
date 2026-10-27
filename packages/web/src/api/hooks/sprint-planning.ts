import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ScrumWorkspace, Sprint, SprintDetail, SprintPlanResult } from "@nod/core";
import { ApiError, apiFetch, type ApiRequest } from "../client";
import { queryKeys } from "../query-keys";
import { useApiMutation } from "./shared";

export function useScrumWorkspace(key: string, enabled = true) {
  return useQuery({ queryKey: queryKeys.scrumWorkspace(key), queryFn: () => apiFetch<ScrumWorkspace>(`/workspaces/${encodeURIComponent(key)}/scrum`), enabled });
}

// 応答喪失後も同じ入力は同じ版・requestKeyで再送する。競合後は読み直した版で再試行できる。
export function useSprintCommand<T = Sprint | SprintPlanResult | SprintDetail | ScrumWorkspace>() {
  const busy = useRef(false);
  const last = useRef<{ signature: string; path: string; request: ApiRequest } | null>(null);
  const mutation = useApiMutation<{ path: string; request: ApiRequest }, T>(({ path, request }) => apiFetch<T>(path, request));
  async function run(path: string, body: Record<string, unknown>, method: ApiRequest["method"] = "POST"): Promise<T> {
    if (busy.current) throw new Error("保存中です");
    const { expectedVersion: _version, ...content } = body;
    const signature = JSON.stringify({ path, method, content });
    if (last.current?.signature !== signature) last.current = { signature, path, request: { method, body: { ...body, requestKey: crypto.randomUUID() } } };
    busy.current = true;
    try {
      const result = await mutation.mutateAsync(last.current);
      last.current = null;
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) last.current = null;
      throw error;
    } finally {
      busy.current = false;
    }
  }
  return { ...mutation, run };
}

export function useSprintFlow(ref: string, planId: string | null, enabled: boolean) {
  return useQuery({ queryKey: queryKeys.sprintFlow(ref, planId), queryFn: () => apiFetch<import("@nod/core").SprintFlow>(`/sprints/${encodeURIComponent(ref)}/flow${planId ? `?planId=${encodeURIComponent(planId)}` : ""}`), enabled });
}

export function useSprintPlanningStatus(ref: string, enabled = true) {
  return useQuery({ queryKey: queryKeys.sprintPlanningStatus(ref), queryFn: () => apiFetch<import("@nod/core").SprintPlanningStatus>(`/sprints/${encodeURIComponent(ref)}/planning-status`), enabled, refetchInterval: 30_000, refetchOnWindowFocus: true });
}
