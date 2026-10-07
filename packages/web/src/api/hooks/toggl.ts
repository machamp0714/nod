import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { issuePath, queryKeys } from "../query-keys";
import type { TogglIssueView } from "../types";

// Toggl 打刻（NOD-6）。Toggl の呼び出しは server が行い、web は server の API だけを呼ぶ（トークンは受け取らない）。
// Toggl の利用枠を使うため、フォーカスのたびには取り直さない
export function useToggl(id: string) {
  return useQuery({
    queryKey: queryKeys.toggl(id),
    queryFn: () => apiFetch<TogglIssueView>(issuePath(id, "toggl")),
    refetchOnWindowFocus: false,
  });
}

// 開始・停止は nod の DB を変えないので、すべてのクエリを無効にせず、応答の状態をそのまま表示に使う
export function useTogglAction(id: string) {
  const queryClient = useQueryClient();
  return useMutation<TogglIssueView, Error, "start" | "stop">({
    mutationFn: (op) => apiFetch<TogglIssueView>(issuePath(id, `toggl/${op}`), { method: "POST" }),
    onSuccess: (view) => queryClient.setQueryData(queryKeys.toggl(id), view),
    // 失敗したら Toggl 側の状態が分からないので取り直す
    onError: () => queryClient.invalidateQueries({ queryKey: queryKeys.toggl(id) }),
  });
}
