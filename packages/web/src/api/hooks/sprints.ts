import { useEffect, useState } from "react";
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

export function useSprintRecords(ref: string) {
  return useQuery({ queryKey: queryKeys.sprintRecords(ref), queryFn: () => apiFetch<import("@nod/core").SprintRecord[]>(`/sprints/${encodeURIComponent(ref)}/records`), refetchOnWindowFocus: true });
}

export function useSprintAnalytics(ref: string, enabled: boolean, timezone?: string) {
  return useQuery({ queryKey: queryKeys.sprintAnalytics(ref, timezone), queryFn: () => apiFetch<SprintAnalytics>(`/sprints/${encodeURIComponent(ref)}/analytics${timezone ? `?tz=${encodeURIComponent(timezone)}` : ""}`), enabled });
}

export function useLegacyCycle(oldId: string, enabled = true) {
  return useQuery({ queryKey: queryKeys.legacyCycle(oldId), queryFn: () => apiFetch<LegacyCycleResolution>(`/cycles/${encodeURIComponent(oldId)}`), enabled });
}

// 鮮度はDB変更なしでも変化する。非表示中は止め、復帰時は保存状態を取り直す。
export function useSprintExecution(ref: string, enabled = true) {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const query = useQuery({ queryKey: queryKeys.sprintExecution(ref),
    queryFn: () => apiFetch<import("../types").SprintNotificationState>(`/sprints/${encodeURIComponent(ref)}/execution`),
    enabled: enabled && visible, refetchInterval: visible ? 30_000 : false, refetchIntervalInBackground: false, refetchOnWindowFocus: true });
  const { refetch } = query;
  useEffect(() => {
    const changed = () => {
      const current = document.visibilityState !== "hidden";
      setVisible(current);
      if (current && enabled) void refetch();
    };
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, [enabled, refetch]);
  return query;
}
