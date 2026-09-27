import type { AgentState, Status, StepStatus } from "../api/types";
import type { IconName } from "../components/ui/Icon";

export type Tone = "ready" | "ask" | "gate" | "accent" | "fail" | "muted";

export const TONE_COLORS: Record<Tone, { fg: string; bg: string }> = {
  ready: { fg: "var(--ready)", bg: "var(--ready-soft)" },
  ask: { fg: "var(--ask)", bg: "var(--ask-soft)" },
  gate: { fg: "var(--gate)", bg: "var(--gate-soft)" },
  accent: { fg: "var(--accent)", bg: "var(--accent-soft)" },
  fail: { fg: "var(--fail)", bg: "var(--fail-soft)" },
  muted: { fg: "var(--ink3)", bg: "var(--sunken)" },
};

export interface Meta {
  label: string;
  icon: IconName;
  tone: Tone;
}

// spec のステータスの表の順。
export const STATUS_ORDER: readonly Status[] = [
  "triage",
  "backlog",
  "needs_clarification",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
];

// spec の Issue 一覧の節：カンバンは Triage と Canceled を出さない。
export const BOARD_STATUSES: readonly Status[] = ["needs_clarification", "backlog", "todo", "in_progress", "in_review", "done"];

export const STATUS_META: Record<Status, Meta> = {
  triage: { label: "Triage", icon: "circle-dashed", tone: "ask" },
  backlog: { label: "Backlog", icon: "circle-dot-dashed", tone: "muted" },
  needs_clarification: { label: "Needs Clarification", icon: "message-circle-warning", tone: "ask" },
  todo: { label: "Todo", icon: "circle", tone: "muted" },
  in_progress: { label: "In Progress", icon: "circle-dot", tone: "accent" },
  in_review: { label: "In Review", icon: "circle-ellipsis", tone: "ready" },
  done: { label: "Done", icon: "circle-check", tone: "muted" },
  canceled: { label: "Canceled", icon: "circle-x", tone: "muted" },
};

export function statusLabel(value: unknown): string {
  return (STATUS_ORDER as readonly unknown[]).includes(value) ? STATUS_META[value as Status].label : String(value);
}

const NO_PRIORITY: Meta = { label: "No priority", icon: "minus", tone: "muted" };

const PRIORITY_META: readonly Meta[] = [
  NO_PRIORITY,
  { label: "Urgent", icon: "circle-alert", tone: "fail" },
  { label: "High", icon: "signal-high", tone: "muted" },
  { label: "Medium", icon: "signal-medium", tone: "muted" },
  { label: "Low", icon: "signal-low", tone: "muted" },
];

export function priorityMeta(priority: number): Meta {
  return PRIORITY_META[priority] ?? NO_PRIORITY;
}

export const AGENT_STATE_META: Record<AgentState, Meta> = {
  working: { label: "作業中", icon: "loader-circle", tone: "accent" },
  awaiting_input: { label: "入力待ち", icon: "message-circle-warning", tone: "ask" },
  error: { label: "エラー", icon: "circle-alert", tone: "fail" },
  done: { label: "完了", icon: "circle-check", tone: "ready" },
};

export const STEP_META: Record<StepStatus, Meta> = {
  pending: { label: "未着手", icon: "circle", tone: "muted" },
  doing: { label: "作業中", icon: "circle-dot", tone: "accent" },
  done: { label: "完了", icon: "circle-check", tone: "ready" },
  skipped: { label: "省略", icon: "circle-x", tone: "muted" },
};
