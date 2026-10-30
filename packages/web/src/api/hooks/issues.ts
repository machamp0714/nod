import { useSprints, useCurrentSprints } from "./sprints";
import { useQuery } from "@tanstack/react-query";
import type { IssueListRow } from "../../components/issue-list/types";
import { issueQueryToParams, milestoneProjectProblem, NO_SPRINT, type FilterOptions } from "../../lib/issue-filter";
import { sprintOptions } from "../../lib/analytics";
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
  sprintIds?: string[];
  emptyMessage?: string;
  retry?: () => void;
}

// Issue 一覧（Issues、Views、Project 詳細）の行。範囲の Issue と、同じ範囲の Ready の Issue を読む。
// 条件の Project が一覧にないときは、core が NOT_FOUND を返すため、API を呼ばずにメッセージを返す。
// enabled が false の間は API を呼ばない（Cycle 詳細で、一覧にない ID の 404 を出さないため）
export function useIssueRows(query: IssueQuery, enabled = true): IssueRowsState {
  const projects = useProjects();
  const milestones = useMilestones();
  const sprints = useSprints();
  const ref = query.project;
  const unknownProject =
    ref !== undefined && projects.data !== undefined && !projects.data.some((p) => String(p.id) === ref || p.name === ref);
  // 消えた Milestone の ID も core が NOT_FOUND を返すため、同じく API を呼ばない
  const milestoneRef = query.milestone !== undefined && query.milestone !== "none" ? query.milestone : undefined;
  const unknownMilestone =
    milestoneRef !== undefined && milestones.data !== undefined && !milestones.data.some((m) => String(m.id) === milestoneRef);
  // 消えた Cycle の ID（URL や保存済みの View に残ったもの）も同じく API を呼ばない
  const sprintRef = query.sprint !== undefined && query.sprint !== NO_SPRINT && query.sprint !== "current" ? query.sprint : undefined;
  const unknownSprint = sprintRef !== undefined && sprints.data !== undefined && !sprints.data.some((c) => (c.id === sprintRef || String(c.number) === sprintRef));
  // Project と Milestone の食い違い（保存済みの View など）も core が INVALID_ARGS を返すため、同じく API を呼ばない
  const mismatch = milestoneProjectProblem(query, projects.data, milestones.data);
  const canFetch =
    enabled &&
    mismatch === null &&
    (ref === undefined || (projects.data !== undefined && !unknownProject)) &&
    (milestoneRef === undefined || (milestones.data !== undefined && !unknownMilestone)) &&
    (sprintRef === undefined || (sprints.data !== undefined && !unknownSprint));
  const current = useCurrentSprints(query.archived === true);
  const all = useIssueList(query, canFetch);
  const ready = useIssueList({ ...query, ready: true }, canFetch);
  const workspaces = useWorkspaces();

  if (unknownProject) return { rows: [], loading: false, error: `条件の Project（${ref}）が見つかりません` };
  if (unknownMilestone) return { rows: [], loading: false, error: `条件の Milestone（${milestoneRef}）が見つかりません` };
  if (unknownSprint) return { rows: [], loading: false, error: `条件の Sprint（${sprintRef}）が見つかりません` };
  if (mismatch) return { rows: [], loading: false, error: mismatch };
  const failed = [
    all,
    ready,
    workspaces,
    ...(query.sprint === "current" ? [current] : []),
    ...(ref === undefined ? [] : [projects]),
    ...(milestoneRef === undefined ? [] : [milestones]),
    ...(sprintRef === undefined ? [] : [sprints]),
  ].find((q) => q.error);
  if (failed?.error) return { rows: [], loading: false, error: errorMessage(failed.error), retry: () => { for (const request of [all, ready, workspaces, current, projects, milestones, sprints]) void request.refetch(); } };
  if (!all.data || !ready.data || !workspaces.data) return { rows: [], loading: true, error: null };
  if (query.sprint === "current" && !current.data) return { rows: [], loading: true, error: null };
  const workspaceIds = new Set(workspaces.data.filter((workspace) => !query.workspace?.length || query.workspace.includes(workspace.key)).map((workspace) => workspace.id));
  const scopedSprints = current.data?.sprints.filter((sprint) => !query.workspace?.length || (sprint.workspaceId !== null && workspaceIds.has(sprint.workspaceId)));
  return { rows: buildRows(all.data.issues, ready.data.issues, workspaces.data), loading: false, error: null,
    sprintIds: query.sprint === "current" ? scopedSprints?.map((item) => item.id) : undefined,
    emptyMessage: query.sprint === "current" && scopedSprints?.length === 0 ? "現在のSprintはありません" : undefined };
}

// 絞り込みのバーの選択肢。ラベルと担当は、すべての Issue に付いているものを集める
export function useFilterOptions(sprintRef?: string): FilterOptions {
  const workspaces = useWorkspaces();
  const projects = useProjects();
  const milestones = useMilestones();
  const sprints = useSprints();
  const all = useIssueList({});
  const projectName = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  return {
    workspaces: (workspaces.data ?? []).map((w) => ({ value: w.key, label: w.name })),
    projects: (projects.data ?? []).map((p) => ({ value: String(p.id), label: p.name })),
    milestones: (milestones.data ?? []).map((m) => ({
      value: String(m.id),
      label: m.name,
      project: projectName.get(m.projectId) ?? "",
      projectId: String(m.projectId),
    })),
    milestoneRefs: milestones.data,
    sprints: sprintOptions(sprints.data ?? [], sprintRef),
    labels: [...new Set((all.data?.issues ?? []).flatMap((i) => i.labels))].sort(),
    assignees: [...new Set((all.data?.issues ?? []).flatMap((i) => (i.assignee ? [i.assignee] : [])))].sort(),
  };
}

// 一覧で選んだ複数 Issue の一括編集。1件でも失敗したら何も変わらず、ApiError の details に失敗一覧が入る
export type BulkUpdateInput = Pick<
  UpdateIssueInput,
  "status" | "priority" | "assignee" | "projectRef" | "milestoneRef" | "estimate" | "dueDate" | "addLabels" | "removeLabels"
>;

export function useBulkUpdateIssues() {
  return useApiMutation((body: BulkUpdateInput & { ids: string[] }) => apiFetch<Issue[]>("/issues/bulk-update", { method: "POST", body }));
}
