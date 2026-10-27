import type { Issue, SprintDetail, SprintPhase } from "../api/types";
import type { IssueListRow } from "../components/issue-list/types";

export const SPRINT_PHASE_LABEL: Record<SprintPhase, string> = {
  imported: "移行履歴・読取専用", draft: "下書き", ready: "準備完了", active: "進行中", ended: "終了", canceled: "中止",
};

// 移行時の元Issueを共通一覧の表示型へ写す。現在のIssueから過去の状態を補わない。
export function sprintSnapshotRows(sprint: SprintDetail): IssueListRow[] {
  const sourceKeys = new Map([...sprint.evidence, ...sprint.items].map(item => [item.snapshot.issue.id, item.sourceIssueKey]));
  return sprint.items.filter((item) => item.origin === "imported").map((item) => {
    const { snapshot } = item;
    const raw = snapshot.issue;
    const text = (key: string) => typeof raw[key] === "string" ? raw[key] as string : null;
    const issue: Issue = {
      id: item.sourceIssueKey, workspace: snapshot.workspace.key, number: Number(item.sourceIssueKey.split("-").at(-1)),
      title: raw.title, description: raw.description, status: raw.status as Issue["status"],
      priority: typeof raw.priority === "number" ? raw.priority : 0,
      estimate: typeof raw.estimate === "number" ? raw.estimate : null,
      dueDate: text("due_date"), assignee: text("assignee"), agentState: null,
      parentId: typeof raw.parent_id === "number" ? sourceKeys.get(raw.parent_id) ?? null : null,
      project: snapshot.project && typeof snapshot.project.id === "number" && typeof snapshot.project.name === "string" ? { id: snapshot.project.id, name: snapshot.project.name } : null,
      milestone: null, sprints: [{ id: sprint.id, number: sprint.number, name: sprint.name, workspaceId: sprint.workspaceId, phase: "imported", association: "imported" }],
      cycle: null, labels: snapshot.labels, blockedBy: [], questionCount: { answered: 0, total: 0 }, completionCandidate: false,
      snoozedUntil: null, prUrl: text("pr_url"), branch: text("branch"), worktree: text("worktree"), closeReason: text("close_reason"),
      createdBy: text("created_by") ?? "不明", createdAt: text("created_at") ?? snapshot.capturedAt,
      updatedAt: text("updated_at") ?? snapshot.capturedAt, startedAt: text("started_at"), closedAt: text("closed_at"), archivedAt: text("archived_at"),
    };
    return { issue, ready: false, questions: { decided: 0, total: 0 }, workspaceName: snapshot.workspace.name, hasParent: typeof raw.parent_id === "number" };
  });
}
