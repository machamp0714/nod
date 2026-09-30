import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { CycleDetail, CycleSummary, MoveOpenIssuesResult } from "../types";
import { useApiMutation } from "./shared";

// 「現在」の Cycle はブラウザのタイムゾーンの今日で決める
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// すべての Workspace の Cycle（Workspace のキー、開始日の順）
export function useCycles() {
  const tz = browserTimeZone();
  return useQuery({
    queryKey: queryKeys.cycleList(tz),
    queryFn: () => apiFetch<CycleSummary[]>(`/cycles?tz=${encodeURIComponent(tz)}`),
  });
}

// 存在を一覧で確かめてから呼ぶ
export function useCycle(id: number, enabled: boolean) {
  const tz = browserTimeZone();
  return useQuery({
    queryKey: queryKeys.cycle(id, tz),
    queryFn: () => apiFetch<CycleDetail>(`/cycles/${id}?tz=${encodeURIComponent(tz)}`),
    enabled,
  });
}

export function useCreateCycle() {
  return useApiMutation<{ workspace: string; name: string; startDate: string; endDate: string }, CycleSummary>(({ workspace, ...body }) =>
    apiFetch<CycleSummary>(`/workspaces/${encodeURIComponent(workspace)}/cycles?tz=${encodeURIComponent(browserTimeZone())}`, {
      method: "POST",
      body,
    }),
  );
}

export function useMoveOpenIssues(id: number) {
  return useApiMutation<{ to: number }, MoveOpenIssuesResult>(({ to }) =>
    apiFetch<MoveOpenIssuesResult>(`/cycles/${id}/move-open?tz=${encodeURIComponent(browserTimeZone())}`, {
      method: "POST",
      body: { to: String(to) },
    }),
  );
}
