import type { ActivityItem, AgentState } from "../api/types";
import type { IconName } from "../components/ui/Icon";
import { AGENT_STATE_META, priorityMeta, statusLabel } from "./meta";

export interface ActivityLine {
  icon: IconName;
  text: string;
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

function personLabel(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : "なし";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function withReason(text: string, data: Record<string, unknown>): string {
  return typeof data.reason === "string" && data.reason !== "" ? `${text}：${data.reason}` : text;
}

// spec：書き手はすべての行に残るため、「me が受け入れた」「claude-code が確認を求めた」のように表示する。
export function describeActivity(item: ActivityItem): ActivityLine {
  if (item.kind === "comment") return { icon: "message-square", text: `${item.actor}：${item.body}` };
  if (item.kind === "question") {
    return item.answer === null
      ? { icon: "message-circle", text: `${item.actor} が確認を求めた：${item.question}` }
      : { icon: "message-circle", text: `${item.actor} の確認依頼に ${item.answeredBy ?? "me"} が回答した：${item.question}` };
  }
  const { actor, data } = item;
  switch (item.type) {
    case "created":
      return { icon: "plus", text: `${actor} が起票した` };
    case "status_changed":
      return { icon: "circle-dot", text: withReason(`${actor} がステータスを ${statusLabel(data.from)} から ${statusLabel(data.to)} に変えた`, data) };
    case "priority_changed":
      return { icon: "signal-high", text: `${actor} が優先度を ${priorityLabel(data.from)} から ${priorityLabel(data.to)} に変えた` };
    case "assignee_changed":
      return { icon: "circle-user", text: `${actor} が担当者を ${personLabel(data.from)} から ${personLabel(data.to)} に変えた` };
    case "title_changed":
      return { icon: "square-pen", text: `${actor} がタイトルを変えた` };
    case "description_changed":
      return { icon: "square-pen", text: `${actor} が説明を変えた` };
    case "project_changed":
      return { icon: "box", text: `${actor} が Project を変えた` };
    case "parent_changed":
      return { icon: "arrow-right", text: `${actor} が親 Issue を変えた` };
    case "labels_changed": {
      const parts = [...strings(data.added).map((l) => `+${l}`), ...strings(data.removed).map((l) => `−${l}`)];
      return { icon: "tag", text: `${actor} がラベルを変えた（${parts.join(" ")}）` };
    }
    case "agent_state_changed": {
      const state = agentStateLabel(data.to);
      const agent = typeof data.agent === "string" && data.agent !== "" ? data.agent : null;
      if (data.to === null) {
        return { icon: "loader-circle", text: agent ? `${actor} が ${agent} の作業状況を解除した` : `${actor} が作業状況を解除した` };
      }
      let text: string;
      if (data.trigger === "answer") {
        text = agent ? `${actor} の回答で ${agent} の作業状況が ${state} になった` : `${actor} の回答で作業状況が ${state} になった`;
      } else if (agent) {
        text = agent === actor ? `${agent} の作業状況が ${state} になった` : `${actor} が ${agent} の作業状況を ${state} に変えた`;
      } else {
        text = `${actor} が作業状況を ${state} に変えた`;
      }
      return { icon: "loader-circle", text };
    }
    case "plan_updated":
      return { icon: "list-checks", text: `${actor} が計画を更新した` };
    case "document_attached":
      return { icon: "file-text", text: `${actor} が Document を添付した` };
    case "document_detached":
      return { icon: "file-text", text: `${actor} が Document を外した` };
    case "relation_added":
      return { icon: "arrow-right", text: `${actor} が関連 Issue を足した：${String(data.type)} ${String(data.to)}` };
    case "triage_accepted":
      return { icon: "check", text: withReason(`${actor} が受け入れた`, data) };
    case "triage_declined":
      return { icon: "circle-x", text: withReason(`${actor} が却下した`, data) };
    case "review_approved":
      return { icon: "circle-check", text: withReason(`${actor} が承認した`, data) };
    case "review_rejected":
      return { icon: "undo-2", text: withReason(`${actor} が差し戻した`, data) };
    default:
      return { icon: "circle", text: `${actor}: ${item.type}` };
  }
}
