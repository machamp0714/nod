import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { mutableQueries, queryKeys } from "../query-keys";
import type { CycleAnalytics, CycleCadence, CycleDetail, CycleSummary } from "../types";
import { useApiMutation } from "./shared";

// 「現在」の Cycle はブラウザのタイムゾーンの今日で決める
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// すべての Cycle（開始日の順）
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

// 分析パネル（進捗・Cycle graph・内訳）。パネルを開いているあいだだけ取る
export function useCycleAnalytics(id: number, enabled: boolean) {
  const tz = browserTimeZone();
  return useQuery({
    queryKey: queryKeys.cycleAnalytics(id, tz),
    queryFn: () => apiFetch<CycleAnalytics>(`/cycles/${id}/analytics?tz=${encodeURIComponent(tz)}`),
    enabled,
  });
}

export function useCreateCycle() {
  return useApiMutation<{ name: string; startDate: string; endDate: string }, CycleSummary>((body) =>
    apiFetch<CycleSummary>(`/cycles?tz=${encodeURIComponent(browserTimeZone())}`, {
      method: "POST",
      body,
    }),
  );
}

// 全体で1つの周期の設定。未設定なら null
export function useCadence() {
  return useQuery({ queryKey: queryKeys.cycleCadence(), queryFn: () => apiFetch<CycleCadence | null>("/cycle-cadence") });
}

// 設定すると、server が次の要求で今日を含む Cycle と次の1つを作る。成功後の再取得で一覧に出る
export function useSetCadence() {
  return useApiMutation<{ weeks: number; autoCarryOver: boolean; anchorDate?: string }, CycleCadence>((body) =>
    apiFetch<CycleCadence>(`/cycle-cadence?tz=${encodeURIComponent(browserTimeZone())}`, { method: "PUT", body }),
  );
}

export function useClearCadence() {
  return useApiMutation<void, { ok: true }>(() => apiFetch("/cycle-cadence", { method: "DELETE" }));
}

export function useUpdateCycle(id: number) {
  return useApiMutation<{ name?: string; startDate?: string; endDate?: string }, CycleSummary>((body) =>
    apiFetch<CycleSummary>(`/cycles/${id}/update?tz=${encodeURIComponent(browserTimeZone())}`, { method: "POST", body }),
  );
}

// 所属していた Issue は Cycle なしに戻る。issues はその件数。消した Cycle の詳細を開いたまま読み直すと 404 になるため、
// 成功時の読み直しは呼び出し側が画面を移ってから refresh() で行う。失敗時はすぐ読み直す（useDeleteIssue と同じ）
export function useDeleteCycle(id: number) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries(mutableQueries);
  const mutation = useMutation<{ id: number; name: string; issues: number }, Error, void>({
    mutationFn: () => apiFetch(`/cycles/${id}`, { method: "DELETE" }),
    onError: () => refresh(),
  });
  return { ...mutation, refresh };
}
