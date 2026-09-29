import type { ActivityItem } from "../api/types";
import { findIssue, questionsOf } from "./issues";
import { ago } from "./time";

function questionItems(issueId: string): ActivityItem[] {
  return questionsOf(issueId).map((q) => ({
    kind: "question",
    at: q.askedAt,
    actor: q.askedBy,
    question: q.question,
    answer: q.answer,
    answeredBy: q.answeredBy,
    answeredAt: q.answeredAt,
  }));
}

function timeline(issueId: string, items: ActivityItem[]): ActivityItem[] {
  return [...items, ...questionItems(issueId)].sort((a, b) => a.at.localeCompare(b.at));
}

const ACTIVITY: Record<string, ActivityItem[]> = {
  "API-12": timeline("API-12", [
    { kind: "event", at: ago(60 * 24 * 3), actor: "me", type: "created", data: { status: "todo" } },
    { kind: "event", at: ago(48), actor: "claude-code", type: "status_changed", data: { from: "todo", to: "in_progress" } },
    { kind: "event", at: ago(46), actor: "claude-code", type: "plan_updated", data: { source: "2026-09-27-search-n1.md", tasks: 4 } },
    { kind: "comment", id: 1, at: ago(21), actor: "claude-code", body: "N+1 の原因は検索結果ごとの workspace 取得だった。", replies: [], resolvedAt: null, resolvedBy: null },
    { kind: "event", at: ago(12), actor: "claude-code", type: "agent_state_changed", data: { from: "working", to: "awaiting_input" } },
  ]),
  "API-8": timeline("API-8", [
    { kind: "event", at: ago(60 * 24 * 2), actor: "me", type: "created", data: { status: "todo" } },
    { kind: "event", at: ago(90), actor: "codex", type: "status_changed", data: { from: "todo", to: "in_progress" } },
  ]),
};

// Issue の events、コメント、質問を時刻順に並べたダミー。G で GET /api/issues/:id の activity に置き換える。
export function activityOf(issueId: string): ActivityItem[] {
  const known = ACTIVITY[issueId];
  if (known) return known;
  const issue = findIssue(issueId);
  if (!issue) return [];
  return timeline(issueId, [{ kind: "event", at: issue.createdAt, actor: issue.createdBy, type: "created", data: { status: issue.status } }]);
}
