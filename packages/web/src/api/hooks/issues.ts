import { useCycles } from "./cycles";
import { cycleLabel } from "../../lib/cycles";
import { useQuery } from "@tanstack/react-query";
import type { IssueListRow } from "../../components/issue-list/types";
import { issueQueryToParams, NO_CYCLE, type FilterOptions } from "../../lib/issue-filter";
import { buildRows } from "../../lib/issue-rows";
import { apiFetch } from "../client";
import { errorMessage } from "../errors";
import { queryKeys } from "../query-keys";
import type { Issue, IssueList, IssueQuery, UpdateIssueInput } from "../types";
import { useMilestones, useProjects } from "./projects";
import { useApiMutation, useWorkspaces } from "./shared";

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
// enabled が false の間は API を呼ばない（Cycle 詳細で、一覧にない ID の 404 を出さないため）
export function useIssueRows(query: IssueQuery, enabled = true): IssueRowsState {
  const projects = useProjects();
  const milestones = useMilestones();
  const cycles = useCycles();
  const ref = query.project;
  const unknownProject =
    ref !== undefined && projects.data !== undefined && !projects.data.some((p) => String(p.id) === ref || p.name === ref);
  // 消えた Milestone の ID も core が NOT_FOUND を返すため、同じく API を呼ばない
  const milestoneRef = query.milestone !== undefined && query.milestone !== "none" ? query.milestone : undefined;
  const unknownMilestone =
    milestoneRef !== undefined && milestones.data !== undefined && !milestones.data.some((m) => String(m.id) === milestoneRef);
  // 消えた Cycle の ID（URL や保存済みの View に残ったもの）も同じく API を呼ばない
  const cycleRef = query.cycle !== undefined && query.cycle !== NO_CYCLE ? query.cycle : undefined;
  const unknownCycle = cycleRef !== undefined && cycles.data !== undefined && !cycles.data.some((c) => String(c.id) === cycleRef);
  const canFetch =
    enabled &&
    (ref === undefined || (projects.data !== undefined && !unknownProject)) &&
    (milestoneRef === undefined || (milestones.data !== undefined && !unknownMilestone)) &&
    (cycleRef === undefined || (cycles.data !== undefined && !unknownCycle));
  const all = useIssueList(query, canFetch);
  const ready = useIssueList({ ...query, ready: true }, canFetch);
  const workspaces = useWorkspaces();

  if (unknownProject) return { rows: [], loading: false, error: `条件の Project（${ref}）が見つかりません` };
  if (unknownMilestone) return { rows: [], loading: false, error: `条件の Milestone（${milestoneRef}）が見つかりません` };
  if (unknownCycle) return { rows: [], loading: false, error: `条件の Cycle（${cycleRef}）が見つかりません` };
  const failed = [
    all,
    ready,
    workspaces,
    ...(ref === undefined ? [] : [projects]),
    ...(milestoneRef === undefined ? [] : [milestones]),
    ...(cycleRef === undefined ? [] : [cycles]),
  ].find((q) => q.error);
  if (failed?.error) return { rows: [], loading: false, error: errorMessage(failed.error) };
  if (!all.data || !ready.data || !workspaces.data) return { rows: [], loading: true, error: null };
  return { rows: buildRows(all.data.issues, ready.data.issues, workspaces.data), loading: false, error: null };
}

// 絞り込みのバーの選択肢。ラベルは、すべての Issue に付いているものを集める
export function useFilterOptions(): FilterOptions {
  const workspaces = useWorkspaces();
  const projects = useProjects();
  const milestones = useMilestones();
  const cycles = useCycles();
  const all = useIssueList({});
  const projectName = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  return {
    workspaces: (workspaces.data ?? []).map((w) => ({ value: w.key, label: w.name })),
    projects: (projects.data ?? []).map((p) => ({ value: String(p.id), label: p.name })),
    milestones: (milestones.data ?? []).map((m) => ({ value: String(m.id), label: m.name, project: projectName.get(m.projectId) ?? "" })),
    cycles: (cycles.data ?? []).map((c) => ({ value: String(c.id), label: cycleLabel(c, cycles.data ?? []) })),
    labels: [...new Set((all.data?.issues ?? []).flatMap((i) => i.labels))].sort(),
  };
}

// 一覧で選んだ複数 Issue の一括編集。1件でも失敗したら何も変わらず、ApiError の details に失敗一覧が入る
export type BulkUpdateInput = Pick<
  UpdateIssueInput,
  "status" | "priority" | "assignee" | "projectRef" | "estimate" | "dueDate" | "addLabels" | "removeLabels"
>;

export function useBulkUpdateIssues() {
  return useApiMutation((body: BulkUpdateInput & { ids: string[] }) => apiFetch<Issue[]>("/issues/bulk-update", { method: "POST", body }));
}
