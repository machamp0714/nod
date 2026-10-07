import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../client";
import { issuePath, queryKeys } from "../query-keys";
import type { TogglFailureDetails, TogglIssueView } from "../types";

// Toggl 打刻（NOD-6）。Toggl の呼び出しは server が行い、web は server の API だけを呼ぶ（トークンは受け取らない）。
// server は現在の打刻を 5 分キャッシュするので、読み直し（SSE の変更通知など）は期限内なら Toggl を呼ばない。
// Toggl を呼べなかったときも server は 200 で最後に分かっている状態と理由（failure）を返す。
// 取得の失敗は自動では再試行しない（Toggl の利用枠を使う）。フォーカスのたびにも取り直さない
export function useToggl(id: string) {
  return useQuery({
    queryKey: queryKeys.toggl(id),
    queryFn: () => apiFetch<TogglIssueView>(issuePath(id, "toggl")),
    refetchOnWindowFocus: false,
    retry: false,
  });
}

// 「最新にする」。server のキャッシュを無視して Toggl から取り直し、その状態を表示に使う。
// nod の DB は変えないので、すべてのクエリは無効にしない
export function useTogglRefresh(id: string) {
  const queryClient = useQueryClient();
  return useMutation<TogglIssueView, Error, void>({
    mutationFn: () => apiFetch<TogglIssueView>(issuePath(id, "toggl/refresh"), { method: "POST" }),
    onSuccess: (view) => queryClient.setQueryData(queryKeys.toggl(id), view),
  });
}

// 開始・停止は nod の DB を変えないので、すべてのクエリを無効にせず、応答の状態をそのまま表示に使う
export function useTogglAction(id: string) {
  const queryClient = useQueryClient();
  return useMutation<TogglIssueView, Error, "start" | "stop">({
    mutationFn: (op) => apiFetch<TogglIssueView>(issuePath(id, `toggl/${op}`), { method: "POST" }),
    onSuccess: (view) => queryClient.setQueryData(queryKeys.toggl(id), view),
    // 失敗・競合では server が取り直した状態を返すので、それを表示に使う（Toggl の利用枠を使うため、もう一度は取り直さない）。
    // 取り直しにも失敗したときは、server が成否不明（unconfirmed）の状態を返すので、それを表示に使い、ここでも取り直さない。
    // 補足の無い失敗は Toggl 側の状態が分からないので取り直す。どの失敗でも開始・停止は再送しない
    onError: (err) => {
      const details = err instanceof ApiError ? (err.details as Partial<TogglFailureDetails> | undefined) : undefined;
      if (details && "view" in details) {
        if (details.view) queryClient.setQueryData(queryKeys.toggl(id), details.view);
        return;
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.toggl(id) });
    },
  });
}
