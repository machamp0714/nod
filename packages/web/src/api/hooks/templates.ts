import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { Template } from "../types";
import { useApiMutation } from "./shared";

// テンプレートは全 Workspace 共通。定期Issueの本文に選び、Workspace の設定で管理する（#160）
export function useTemplates() {
  return useQuery({ queryKey: queryKeys.templates(), queryFn: () => apiFetch<Template[]>("/templates") });
}

// 名前には / なども入りうるので、パスではなく本文で渡す
export function useAddTemplate() {
  return useApiMutation((input: { name: string; body: string }) => apiFetch<Template>("/templates", { method: "POST", body: input }));
}

export function useUpdateTemplate() {
  return useApiMutation((input: { name: string; body: string }) => apiFetch<Template>("/templates/update", { method: "POST", body: input }));
}

export function useRemoveTemplate() {
  return useApiMutation((name: string) => apiFetch<{ name: string; removed: true }>("/templates/remove", { method: "POST", body: { name } }));
}
