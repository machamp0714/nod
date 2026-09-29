import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { issuePath, queryKeys } from "../query-keys";
import type { PrDiffFile, PrDiffView } from "../types";
import { useApiMutation } from "./shared";

// PR の差分（#55）。表示は保存済みの結果だけを読み、gh の実行は「更新」の明示操作でだけ行う
export function usePrDiff(id: string, enabled = true) {
  return useQuery({ queryKey: queryKeys.prDiff(id), queryFn: () => apiFetch<PrDiffView>(issuePath(id, "pr-diff")), enabled });
}

// 1ファイルの patch。開いたファイルだけ取得する（enabled）。キーに取得の HEAD と時刻を含め、取り直したら読み直す
export function usePrDiffFile(id: string, diff: { headSha: string; fetchedAt: string }, path: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.prDiffFile(id, diff.headSha, diff.fetchedAt, path),
    queryFn: () => apiFetch<PrDiffFile>(`${issuePath(id, "pr-diff/files")}?path=${encodeURIComponent(path)}`),
    enabled,
    staleTime: Infinity,
    meta: { immutable: true },
  });
}

export function useRefreshPrDiff(id: string) {
  return useApiMutation(() => apiFetch<PrDiffView>(issuePath(id, "pr-diff/refresh"), { method: "POST" }));
}
