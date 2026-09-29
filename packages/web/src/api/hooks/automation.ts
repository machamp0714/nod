import { useMutation, useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { AutomationRun, AutomationSettings, AutomationTargets } from "../types";
import { useApiMutation } from "./shared";

function automationPath(key: string, op?: string): string {
  return `/workspaces/${encodeURIComponent(key)}/automation${op ? `/${op}` : ""}`;
}

export function useAutomationSettings(key: string, enabled = true) {
  return useQuery({ queryKey: queryKeys.automation(key), queryFn: () => apiFetch<AutomationSettings>(automationPath(key)), enabled });
}

export function useSaveAutomationSettings(key: string) {
  return useApiMutation((input: { closeAfterDays: number | null; archiveAfterDays: number | null }) =>
    apiFetch<AutomationSettings>(automationPath(key), { method: "PUT", body: input }),
  );
}

// 対象の確認（dry-run）。何も変えないので、ほかのデータを取り直さない
export function useAutomationDryRun(key: string) {
  return useMutation<AutomationRun, Error, void>({
    mutationFn: () => apiFetch<AutomationRun>(automationPath(key, "run"), { method: "POST", body: { dryRun: true } }),
  });
}

// 確認時点の一覧（targets）だけを処理する。その後に条件から外れたものはスキップとして返る
export function useRunAutomation(key: string) {
  return useApiMutation((targets: AutomationTargets) =>
    apiFetch<AutomationRun>(automationPath(key, "run"), { method: "POST", body: { dryRun: false, targets } }),
  );
}
