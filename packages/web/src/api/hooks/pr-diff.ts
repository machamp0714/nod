import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { issuePath, queryKeys } from "../query-keys";
import type { PrDiffView } from "../types";
import { useApiMutation } from "./shared";

// PR の差分（#55）。表示は保存済みの結果だけを読み、gh の実行は「更新」の明示操作でだけ行う
export function usePrDiff(id: string, enabled = true) {
  return useQuery({ queryKey: queryKeys.prDiff(id), queryFn: () => apiFetch<PrDiffView>(issuePath(id, "pr-diff")), enabled });
}

export function useRefreshPrDiff(id: string) {
  return useApiMutation(() => apiFetch<PrDiffView>(issuePath(id, "pr-diff/refresh"), { method: "POST" }));
}
