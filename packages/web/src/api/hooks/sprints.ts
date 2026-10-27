import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { CurrentSprintResolution, LegacyCycleResolution, Sprint, SprintAnalytics, SprintDetail, SprintUnresolvedHistory } from "../types";

export function useSprints() {
  return useQuery({ queryKey: queryKeys.sprints(), queryFn: () => apiFetch<Sprint[]>("/sprints") });
}

export function useUnresolvedSprintHistory() {
  return useQuery({ queryKey: queryKeys.unresolvedSprintHistory(), queryFn: () => apiFetch<SprintUnresolvedHistory>("/sprints/unresolved-history") });
}

export function useCurrentSprints(archived = false) {
  return useQuery({ queryKey: queryKeys.currentSprints(archived), queryFn: () => apiFetch<CurrentSprintResolution>(`/sprints/current${archived ? "?archived=true" : ""}`) });
}

export function useSprint(ref: string, enabled = true) {
  return useQuery({ queryKey: queryKeys.sprint(ref), queryFn: () => apiFetch<SprintDetail>(`/sprints/${encodeURIComponent(ref)}`), enabled, refetchInterval: 30_000, refetchOnWindowFocus: true });
}

export function useSprintAnalytics(ref: string, enabled: boolean, timezone?: string) {
  return useQuery({ queryKey: queryKeys.sprintAnalytics(ref, timezone), queryFn: () => apiFetch<SprintAnalytics>(`/sprints/${encodeURIComponent(ref)}/analytics${timezone ? `?tz=${encodeURIComponent(timezone)}` : ""}`), enabled });
}

export function useLegacyCycle(oldId: string, enabled = true) {
  return useQuery({ queryKey: queryKeys.legacyCycle(oldId), queryFn: () => apiFetch<LegacyCycleResolution>(`/cycles/${encodeURIComponent(oldId)}`), enabled });
}
