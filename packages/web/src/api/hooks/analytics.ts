import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { CompletionStats, LlmStats } from "../types";

// query は statsQueryString で作ったクエリ文字列。キーにも使い、条件ごとに別の結果として持つ
export function useCompletionStats(query: string) {
  return useQuery({ queryKey: queryKeys.stats("completion", query), queryFn: () => apiFetch<CompletionStats>(`/stats?${query}`) });
}

export function useLlmStats(query: string) {
  return useQuery({ queryKey: queryKeys.stats("llm", query), queryFn: () => apiFetch<LlmStats>(`/stats/llm?${query}`) });
}
