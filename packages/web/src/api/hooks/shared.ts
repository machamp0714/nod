import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { issuePath, mutableQueries, queryKeys } from "../query-keys";
import type { IssueDetail, Workspace } from "../types";

// 2つ以上の画面が使う取得のフック。画面ごとのフックは src/api/hooks/<画面>.ts に置く。
// queryFn は引数を取らない形で包む。TanStack Query が渡す文脈を apiFetch の引数として受けないためである

export function useWorkspaces() {
  return useQuery({ queryKey: queryKeys.workspaces(), queryFn: () => apiFetch<Workspace[]>("/workspaces") });
}

export function useIssueDetail(id: string) {
  return useQuery({ queryKey: queryKeys.issue(id), queryFn: () => apiFetch<IssueDetail>(issuePath(id)) });
}

// web 自身の書き込み。server 自身の書き込みでは SSE の change が来ないため、終わったら自分ですべてのクエリ（immutable を除く）を無効にする。
// 失敗したときも無効にするのは、別の場所で状態が変わっていた（409 など）ときに画面を最新に戻すためである。
// onSettled が読み直しの Promise を返すため、mutateAsync は読み直しが終わってから解決する
export function useApiMutation<TVariables, TResult = unknown>(mutationFn: (variables: TVariables) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation<TResult, Error, TVariables>({
    mutationFn,
    onSettled: () => queryClient.invalidateQueries(mutableQueries),
  });
}
