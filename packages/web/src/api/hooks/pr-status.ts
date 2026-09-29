import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { issuePath, queryKeys } from "../query-keys";
import type { PrStatusView } from "../types";
import { useApiMutation } from "./shared";

// PR 状態（#67）。表示は保存済みの結果だけを読み、gh の実行は「更新」の明示操作でだけ行う
export function usePrStatus(id: string, enabled = true) {
  return useQuery({ queryKey: queryKeys.prStatus(id), queryFn: () => apiFetch<PrStatusView>(issuePath(id, "pr-status")), enabled });
}

export function useRefreshPrStatus(id: string) {
  return useApiMutation(() => apiFetch<PrStatusView>(issuePath(id, "pr-status/refresh"), { method: "POST" }));
}
