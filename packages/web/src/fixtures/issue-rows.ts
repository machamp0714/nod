import type { Issue } from "../api/types";
import type { IssueListRow } from "../components/issue-list/types";
import { countQuestions } from "../lib/format";
import { ISSUES, questionsOf } from "./issues";
import { workspaceName } from "./workspaces";

// Ready の判定はサーバーが行う。ダミーデータでは Ready の Issue を列挙する
// （API-13 は todo だが API-12 にブロックされているため Ready ではない）。
const READY_IDS = new Set(["API-4", "NOD-5"]);

export function issueRow(issue: Issue): IssueListRow {
  return {
    issue,
    questions: countQuestions(questionsOf(issue.id)),
    ready: READY_IDS.has(issue.id),
    workspaceName: workspaceName(issue.workspace),
  };
}

export const ISSUE_ROWS: IssueListRow[] = ISSUES.map(issueRow);
