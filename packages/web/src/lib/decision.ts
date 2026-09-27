import type { InboxQuestion, Plan, Workspace } from "../api/types";

export function workspaceNameOf(workspaces: readonly Pick<Workspace, "key" | "name">[] | undefined, key: string): string {
  return workspaces?.find((w) => w.key === key)?.name ?? key;
}

export interface InboxEntry {
  issueId: string;
  issueTitle: string;
  workspace: string;
  branch: string | null;
  worktree: string | null;
  questions: InboxQuestion[]; // server の順（質問の古い順）
  latestAt: string;
}

// GET /api/inbox は質問ごとに古い順で返す。画面は Issue ごとに1項目にまとめ、最後に質問が来た Issue を上にする
export function groupInbox(questions: readonly InboxQuestion[]): InboxEntry[] {
  const entries = new Map<string, InboxEntry>();
  for (const question of questions) {
    const entry = entries.get(question.issueId);
    if (entry) {
      entry.questions.push(question);
      if (question.askedAt > entry.latestAt) entry.latestAt = question.askedAt;
      continue;
    }
    entries.set(question.issueId, {
      issueId: question.issueId,
      issueTitle: question.issueTitle,
      workspace: question.workspace,
      branch: question.branch,
      worktree: question.worktree,
      questions: [question],
      latestAt: question.askedAt,
    });
  }
  return [...entries.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt) || a.issueId.localeCompare(b.issueId));
}

export function doingTaskTitle(plan: Plan): string | null {
  return plan.tasks.find((t) => t.status === "doing")?.title ?? null;
}
