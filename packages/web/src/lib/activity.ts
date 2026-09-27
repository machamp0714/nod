import type { ActivityItem, AgentState } from "../api/types";
import type { IconName } from "../components/ui/Icon";
import { AGENT_STATE_META, statusLabel } from "./meta";

export interface ActivityLine {
  icon: IconName;
  text: string;
}

function agentStateLabel(value: unknown): string {
  return typeof value === "string" && value in AGENT_STATE_META ? AGENT_STATE_META[value as AgentState].label : String(value);
}

// spec：書き手はすべての行に残るため、「me が受け入れた」「claude-code が確認を求めた」のように表示する。
// G で events の種類ごとの文を足す。
export function describeActivity(item: ActivityItem): ActivityLine {
  if (item.kind === "comment") return { icon: "message-square", text: item.body };
  if (item.kind === "question") {
    return item.answer === null
      ? { icon: "message-circle", text: `${item.actor} が確認を求めた：${item.question}` }
      : { icon: "message-circle", text: `${item.actor} の確認依頼に ${item.answeredBy ?? "me"} が回答した：${item.question}` };
  }
  const { data } = item;
  switch (item.type) {
    case "created":
      return { icon: "plus", text: `${item.actor} が起票した` };
    case "status_changed":
      return { icon: "circle-dot", text: `${item.actor} がステータスを ${statusLabel(data.from)} から ${statusLabel(data.to)} に変えた` };
    case "agent_state_changed":
      return { icon: "loader-circle", text: `${item.actor} の作業状況が ${agentStateLabel(data.to)} になった` };
    case "plan_updated":
      return { icon: "list-checks", text: `${item.actor} が計画を更新した` };
    case "document_attached":
      return { icon: "file-text", text: `${item.actor} が Document を添付した` };
    default:
      return { icon: "circle", text: `${item.actor}: ${item.type}` };
  }
}
