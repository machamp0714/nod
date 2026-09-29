import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { RecurringIssue, RecurringIssueInput, RecurringRun, Template } from "../types";
import { useApiMutation } from "./shared";

function recurringPath(key: string, rest = ""): string {
  return `/workspaces/${encodeURIComponent(key)}/recurring${rest}`;
}

export function useRecurringIssues(key: string) {
  return useQuery({ queryKey: queryKeys.recurringIssues(key), queryFn: () => apiFetch<RecurringIssue[]>(recurringPath(key)) });
}

export function useAddRecurringIssue(key: string) {
  return useApiMutation((input: RecurringIssueInput) => apiFetch<RecurringIssue>(recurringPath(key), { method: "POST", body: input }));
}

export function useUpdateRecurringIssue(key: string) {
  return useApiMutation(({ id, patch }: { id: number; patch: Partial<RecurringIssueInput> & { enabled?: boolean } }) =>
    apiFetch<RecurringIssue>(recurringPath(key, `/${id}`), { method: "PUT", body: patch }),
  );
}

export function useRemoveRecurringIssue(key: string) {
  return useApiMutation((id: number) => apiFetch<RecurringIssue>(recurringPath(key, `/${id}`), { method: "DELETE" }));
}

export function useRunRecurringIssues(key: string) {
  return useApiMutation((dryRun: boolean) => apiFetch<RecurringRun>(recurringPath(key, "/run"), { method: "POST", body: { dryRun } }));
}

// テンプレートは全 Workspace 共通。定期Issueの本文に選ぶ
export function useTemplates() {
  return useQuery({ queryKey: queryKeys.templates(), queryFn: () => apiFetch<Template[]>("/templates") });
}
