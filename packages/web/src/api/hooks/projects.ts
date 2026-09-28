import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { ProjectSummary } from "../types";

// Projects のタブ（Active、Completed、All）を画面で切り替えるため、完了と中止の Project も読む
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projectList({ includeClosed: true }),
    queryFn: () => apiFetch<ProjectSummary[]>("/projects?includeClosed=true"),
  });
}
