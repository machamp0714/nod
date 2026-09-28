import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { View, ViewInput } from "../types";
import { useApiMutation } from "./shared";

export function useViews() {
  return useQuery({ queryKey: queryKeys.views(), queryFn: () => apiFetch<View[]>("/views") });
}

// 書き込みは H の useApiMutation で書く。終わるとすべてのクエリを読み直し、mutateAsync は読み直しを待ってから解決する
// （View を作った後、Sidebar と View の一覧が揃ってから新しい View に移るため）
export function useCreateView() {
  return useApiMutation((input: ViewInput & { name: string }) => apiFetch<View>("/views", { method: "POST", body: input }));
}

export function useUpdateView() {
  return useApiMutation(({ id, input }: { id: number; input: ViewInput }) =>
    apiFetch<View>(`/views/${id}`, { method: "PUT", body: input }),
  );
}

export function useDeleteView() {
  return useApiMutation((id: number) => apiFetch<View>(`/views/${id}`, { method: "DELETE" }));
}
