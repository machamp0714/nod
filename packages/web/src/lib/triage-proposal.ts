import type { TriageProposal } from "../api/types";
import type { IconName } from "../components/ui";
import { priorityMeta } from "./meta";

// LLM の Triage 提案（#62）の表示と、受け入れフォームへの反映。反映は入力欄を埋めるだけで、確定は人が既存のボタンで行う
export interface AcceptForm {
  projectRef: string;
  priority: number;
  labels: string[];
  assignee: string;
}

export function proposalBadge(p: TriageProposal): { icon: IconName; text: string; tone: "ready" | "gate" | "fail" } {
  switch (p.decision) {
    case "accept":
      return { icon: "check", text: "受け入れ", tone: "ready" };
    case "duplicate":
      return { icon: "copy", text: `重複 ${p.duplicateOf ?? ""}`.trim(), tone: "gate" };
    case "decline":
      return { icon: "x", text: "却下", tone: "fail" };
  }
}

// 提案は me も記録できるので、me の提案を含むときは「LLM の」を付けない（カードごとの書き手名で区別する）
export function proposalsHeading(proposals: readonly TriageProposal[]): string {
  return proposals.some((p) => p.actor === "me") ? "提案" : "LLM の提案";
}

// 提案に指定のある項目だけを置き換え、ラベルは今の入力に足す
export function applyAcceptProposal(form: AcceptForm, p: TriageProposal): AcceptForm {
  return {
    projectRef: p.project ? String(p.project.id) : form.projectRef,
    priority: p.priority ?? form.priority,
    labels: [...form.labels, ...p.labels.filter((l) => !form.labels.includes(l))],
    assignee: p.assignee ?? form.assignee,
  };
}

// 提案に指定のある受け入れ時の属性だけを、受け入れ設定と同じ順（Project・Priority・Labels・Assignee）で返す
export function proposalAttributes(p: TriageProposal): { key: string; icon: IconName; label: string; value: string }[] {
  const out: { key: string; icon: IconName; label: string; value: string }[] = [];
  if (p.project) out.push({ key: "project", icon: "box", label: "Project", value: p.project.name });
  if (p.priority !== null) out.push({ key: "priority", icon: priorityMeta(p.priority).icon, label: "Priority", value: priorityMeta(p.priority).label });
  if (p.labels.length > 0) out.push({ key: "labels", icon: "tag", label: "Labels", value: p.labels.join(", ") });
  if (p.assignee) out.push({ key: "assignee", icon: "circle-user", label: "Assignee", value: p.assignee });
  return out;
}
