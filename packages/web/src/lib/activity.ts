import { describeEvent } from "@nod/core/src/activity-text";
import type { ActivityItem, AgentState } from "../api/types";
import type { IconName } from "../components/ui/Icon";
import { AGENT_STATE_META, priorityMeta, statusLabel } from "./meta";

export interface ActivityLine {
  icon: IconName;
  text: string;
}

// 添付したファイルの元の場所（監査用）。Issue 詳細の Activity にだけ出す
export function attachmentSourcePath(item: ActivityItem): string | null {
  if (item.kind !== "event" || item.type !== "attachment_added") return null;
  const path = item.data.source_path;
  return typeof path === "string" && path ? path : null;
}

// question_asked と question_answered は、同じ質問の行（kind: "question"）と重なるため出さない
const HIDDEN_EVENT_TYPES = new Set(["question_asked", "question_answered"]);

export function visibleActivity(items: readonly ActivityItem[]): ActivityItem[] {
  // core の質問行の at は質問日時。回答の文を出す行は回答日時に並べ直す。
  return items
    .filter((item) => item.kind !== "event" || !HIDDEN_EVENT_TYPES.has(item.type))
    .map((item) =>
      item.kind === "question" && item.answer !== null && item.answeredAt !== null ? { ...item, at: item.answeredAt } : item,
    )
    .sort((a, b) => a.at.localeCompare(b.at));
}

function agentStateLabel(value: unknown): string {
  return typeof value === "string" && value in AGENT_STATE_META ? AGENT_STATE_META[value as AgentState].label : String(value);
}

function priorityLabel(value: unknown): string {
  return typeof value === "number" ? priorityMeta(value).label : String(value);
}

type ActivityEvent = Extract<ActivityItem, { kind: "event" }>;

const EVENT_ICON: Record<string, IconName> = {
  archived: "archive",
  unarchived: "archive-restore",
  pr_linked: "git-pull-request",
  status_changed: "circle-dot",
  priority_changed: "signal-high",
  estimate_changed: "gauge",
  due_date_changed: "calendar",
  assignee_changed: "circle-user",
  title_changed: "square-pen",
  description_changed: "square-pen",
  project_changed: "box",
  milestone_changed: "flag",
  cycle_changed: "calendar-range",
  parent_changed: "arrow-right",
  labels_changed: "tag",
  agent_state_changed: "loader-circle",
  plan_updated: "list-checks",
  document_attached: "file-text",
  document_detached: "file-text",
  relation_added: "arrow-right",
  triage_accepted: "check",
  triage_declined: "circle-x",
  review_approved: "circle-check",
  review_rejected: "undo-2",
  comment_thread_resolved: "circle-check",
  comment_thread_reopened: "undo-2",
};

function eventIcon({ type, data }: ActivityEvent): IconName {
  if (type === "created") {
    if (typeof data.copied_from === "string") return "copy";
    return typeof data.recurring_id === "number" && typeof data.occurrence === "string" ? "calendar" : "plus";
  }
  if (type === "attachment_added" || type === "attachment_removed") return data.kind === "file" ? "paperclip" : "link";
  return EVENT_ICON[type] ?? "circle";
}

// spec：書き手はすべての行に残るため、「me が受け入れた」「claude-code が確認を求めた」のように表示する。
// event の文は CLI と同じ core の describeEvent で作り、Web は補足（detail）を出さない。
// nameOfStatus は Workspace の表示名を使うときに渡す。既定は spec の表示ラベル
export function describeActivity(item: ActivityItem, nameOfStatus: (value: unknown) => string = statusLabel): ActivityLine {
  if (item.kind === "comment") return { icon: "message-square", text: `${item.actor}：${item.body}` };
  if (item.kind === "question") {
    return item.answer === null
      ? { icon: "message-circle", text: `${item.actor} が確認を求めた：${item.question}` }
      : { icon: "message-circle", text: `${item.actor} の確認依頼に ${item.answeredBy ?? "me"} が回答した：${item.question}` };
  }
  const line = describeEvent(item, { status: nameOfStatus, priority: priorityLabel, agentState: agentStateLabel });
  return { icon: eventIcon(item), text: line?.text ?? `${item.actor}: ${item.type}` };
}
