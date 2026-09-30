import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { CompletionStats, LlmStats, Summary } from "../types";

// query は statsQueryString で作ったクエリ文字列。キーにも使い、条件ごとに別の結果として持つ
export function useCompletionStats(query: string, enabled = true) {
  return useQuery({ queryKey: queryKeys.stats("completion", query), queryFn: () => apiFetch<CompletionStats>(`/stats?${query}`), enabled });
}

export function useLlmStats(query: string) {
  return useQuery({ queryKey: queryKeys.stats("llm", query), queryFn: () => apiFetch<LlmStats>(`/stats/llm?${query}`) });
}

// query は summaryQueryString で作ったクエリ文字列。「他 N 件を表示」で件数を変えても前の結果を出したまま読み直す
export function useSummary(query: string) {
  return useQuery({
    queryKey: queryKeys.summary(query),
    queryFn: () => apiFetch<Summary>(`/summary?${query}`),
    placeholderData: keepPreviousData,
  });
}
