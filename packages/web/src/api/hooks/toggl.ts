import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../client";
import { issuePath, queryKeys } from "../query-keys";
import type { TogglFailureDetails, TogglIssueView, TogglProjectsView } from "../types";

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

// 打刻の欄の Project の選択欄の一覧。server が持ち続けるので、読み直しても Toggl を呼ばない（取り直すのは「最新にする」だけ）。
// 取得の失敗も server は 200 で理由（failure）を添えて返す
export function useTogglProjects() {
  return useQuery({
    queryKey: queryKeys.togglProjects(),
    queryFn: () => apiFetch<TogglProjectsView>("/toggl/projects"),
    refetchOnWindowFocus: false,
    retry: false,
  });
}

// 「最新にする」で Project の一覧も取り直す
export function useTogglProjectsRefresh() {
  const queryClient = useQueryClient();
  return useMutation<TogglProjectsView, Error, void>({
    mutationFn: () => apiFetch<TogglProjectsView>("/toggl/projects/refresh", { method: "POST" }),
    onSuccess: (view) => queryClient.setQueryData(queryKeys.togglProjects(), view),
  });
}

// 打刻の操作。開始（切り替え）は選んだ Project で行い、project は打刻中の Project を変える（projectId が null なら Project なし）
export type TogglActionInput = { op: "start"; projectId: number | null } | { op: "stop" } | { op: "project"; projectId: number | null };

// 開始・停止・Project の変更は nod の DB を変えないので、すべてのクエリを無効にせず、応答の状態をそのまま表示に使う
export function useTogglAction(id: string) {
  const queryClient = useQueryClient();
  return useMutation<TogglIssueView, Error, TogglActionInput>({
    mutationFn: (input) =>
      apiFetch<TogglIssueView>(issuePath(id, `toggl/${input.op}`), {
        method: "POST",
        body: input.op === "stop" ? undefined : { projectId: input.projectId },
      }),
    onSuccess: (view) => queryClient.setQueryData(queryKeys.toggl(id), view),
    // 失敗・競合では server が取り直した状態を返すので、それを表示に使う（Toggl の利用枠を使うため、もう一度は取り直さない）。
    // 取り直しにも失敗したときは、server が成否不明（unconfirmed）の状態を返すので、それを表示に使い、ここでも取り直さない。
    // 補足の無い失敗は Toggl 側の状態が分からないので取り直す。どの失敗でも開始・停止・Project の変更は再送しない
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
