import type { Issue, Workspace } from "../api/types";
import type { IssueListRow } from "../components/issue-list/types";

// GET /api/issues の応答から Issue 一覧の行を作る。
// Issue には Ready の印がないため、同じ範囲を ready=true で読んだ結果に含まれるかで決める。
export function buildRows(
  issues: readonly Issue[],
  readyIssues: readonly Issue[],
  workspaces: readonly Workspace[],
): IssueListRow[] {
  const ready = new Set(readyIssues.map((i) => i.id));
  const names = new Map(workspaces.map((w) => [w.key, w.name]));
  return issues.map((issue) => ({
    issue,
    questions: { decided: issue.questionCount.answered, total: issue.questionCount.total },
    ready: ready.has(issue.id),
    workspaceName: names.get(issue.workspace) ?? issue.workspace,
  }));
}
