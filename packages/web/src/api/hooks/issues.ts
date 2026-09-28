import { useQuery } from "@tanstack/react-query";
import type { IssueListRow } from "../../components/issue-list/types";
import { issueQueryToParams, type FilterOptions } from "../../lib/issue-filter";
import { buildRows } from "../../lib/issue-rows";
import { apiFetch } from "../client";
import { errorMessage } from "../errors";
import { queryKeys } from "../query-keys";
import type { IssueList, IssueQuery } from "../types";
import { useProjects } from "./projects";
import { useWorkspaces } from "./shared";

export function useIssueList(query: IssueQuery, enabled = true) {
  const params = issueQueryToParams(query);
  return useQuery({
    queryKey: queryKeys.issueList(query),
    queryFn: () => apiFetch<IssueList>(`/issues${params}`),
    enabled,
  });
}

export interface IssueRowsState {
  rows: IssueListRow[];
  loading: boolean;
  error: string | null;
}

// Issue 一覧（Issues、Views、Project 詳細）の行。範囲の Issue と、同じ範囲の Ready の Issue を読む。
// 条件の Project が一覧にないときは、core が NOT_FOUND を返すため、API を呼ばずにメッセージを返す。
export function useIssueRows(query: IssueQuery): IssueRowsState {
  const projects = useProjects();
  const ref = query.project;
  const unknownProject =
    ref !== undefined && projects.data !== undefined && !projects.data.some((p) => String(p.id) === ref || p.name === ref);
  const enabled = ref === undefined || (projects.data !== undefined && !unknownProject);
  const all = useIssueList(query, enabled);
  const ready = useIssueList({ ...query, ready: true }, enabled);
  const workspaces = useWorkspaces();

  if (unknownProject) return { rows: [], loading: false, error: `条件の Project（${ref}）が見つかりません` };
  const failed = [all, ready, workspaces, ...(ref === undefined ? [] : [projects])].find((q) => q.error);
  if (failed?.error) return { rows: [], loading: false, error: errorMessage(failed.error) };
  if (!all.data || !ready.data || !workspaces.data) return { rows: [], loading: true, error: null };
  return { rows: buildRows(all.data.issues, ready.data.issues, workspaces.data), loading: false, error: null };
}

// 絞り込みのバーの選択肢。ラベルは、すべての Issue に付いているものを集める
export function useFilterOptions(): FilterOptions {
  const workspaces = useWorkspaces();
  const projects = useProjects();
  const all = useIssueList({});
  return {
    workspaces: (workspaces.data ?? []).map((w) => ({ value: w.key, label: w.name })),
    projects: (projects.data ?? []).map((p) => ({ value: String(p.id), label: p.name })),
    labels: [...new Set((all.data?.issues ?? []).flatMap((i) => i.labels))].sort(),
  };
}
