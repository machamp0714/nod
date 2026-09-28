import type { IssueDetail } from "../api/types";

export function awaitingQuestions(issue: Pick<IssueDetail, "agentState" | "questions">) {
  if (issue.agentState !== "awaiting_input") return [];
  return issue.questions.filter((q) => q.answer === null && q.askedBy !== "me")
    .sort((a, b) => a.askedAt.localeCompare(b.askedAt) || a.id - b.id);
}
