import type { Inbox, InboxQuestion, Issue } from "../api/types";
import { findIssue, ISSUES, QUESTIONS } from "./issues";

function mustFindIssue(id: string): Issue {
  const issue = findIssue(id);
  if (!issue) throw new Error(`${id} がダミーデータにありません`);
  return issue;
}

const inboxQuestions: InboxQuestion[] = QUESTIONS.filter((q) => q.answer === null && q.askedBy !== "me")
  .map((q) => {
    const issue = mustFindIssue(q.issueId);
    return { ...q, issueTitle: issue.title, workspace: issue.workspace, branch: issue.branch, worktree: issue.worktree };
  })
  .sort((a, b) => b.askedAt.localeCompare(a.askedAt));

export const INBOX: Inbox = {
  questions: inboxQuestions,
  reviews: ISSUES.filter((i) => i.status === "in_review").map(i => ({ ...i, reviewSummary: null, reviewReport: null, reviewSubmittedAt: null })),
};

export const TRIAGE_ISSUES: Issue[] = ISSUES.filter((i) => i.status === "triage");
