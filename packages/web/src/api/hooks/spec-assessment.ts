import { apiFetch } from "../client";
import { issuePath } from "../query-keys";
import type { Issue, Workspace } from "../types";
import { useApiMutation } from "./shared";

export const useSaveSpecAssessment = (key: string) => useApiMutation((enabled: boolean) =>
  apiFetch<Workspace>(`/workspaces/${encodeURIComponent(key)}/spec-assessment`, { method: "PUT", body: { enabled } }));
export const useAssessSpec = (id: string) => useApiMutation(() =>
  apiFetch<Issue>(issuePath(id, "assess-spec"), { method: "POST", body: {} }));
