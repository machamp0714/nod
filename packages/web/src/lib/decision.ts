import type { ActivityItem, InboxQuestion, Plan, Workspace } from "../api/types";

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

export interface ReviewReport {
  actor: string;
  at: string;
  body: string;
}

// nod issue done は、報告をコメントで残してから in_review に変える（CLI 計画の completeIssue）。
// そのため、最後に in_review に変わった時刻以前の、最も新しいコメントを報告とする。Activity は時刻順である
export function reviewReport(activity: readonly ActivityItem[]): ReviewReport | null {
  let reviewAt: string | null = null;
  for (const item of activity) {
    if (item.kind === "event" && item.type === "status_changed" && item.data.to === "in_review") reviewAt = item.at;
  }
  if (reviewAt === null) return null;
  let report: ReviewReport | null = null;
  for (const item of activity) {
    if (item.kind === "comment" && item.at <= reviewAt) report = { actor: item.actor, at: item.at, body: item.body };
  }
  return report;
}

// 後回しの期限の既定と最小。日付だけの値は、core が地域の時刻の 0 時として解釈するため、今日を選ぶと期限がすでに過ぎている
export function tomorrow(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
