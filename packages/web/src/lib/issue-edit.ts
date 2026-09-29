import type { Status } from "../api/types";
import { STATUS_ORDER, statusLabel } from "./meta";

export interface Choice<T extends string> {
  value: T;
  label: string;
  disabled: boolean;
}

// needs_clarification は core が確認依頼に応じて切り替え、手では変えられない（spec）。
// 今の値が needs_clarification のときだけ、select が値を表示できるよう選べない項目として残す。
export function statusChoices(current: Status, nameOf: (status: Status) => string = statusLabel): Choice<Status>[] {
  return STATUS_ORDER.filter((status) => status !== "needs_clarification" || status === current).map((status) => ({
    value: status,
    label: nameOf(status),
    disabled: status === "needs_clarification",
  }));
}

export const KNOWN_ASSIGNEES = ["me", "claude-code", "codex"] as const;

export function assigneeChoices(current: string | null): string[] {
  const known: string[] = [...KNOWN_ASSIGNEES];
  return current && !known.includes(current) ? [...known, current] : known;
}

export function parseLabels(text: string, existing: readonly string[]): string[] {
  const seen = new Set(existing);
  const labels: string[] = [];
  for (const raw of text.split(/[\s,、，]+/)) {
    const label = raw.trim();
    if (label === "" || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

// 空白だけの説明は「説明なし」として保存する
export function descriptionInput(text: string): string | null {
  return hasText(text) ? text : null;
}

export function hasText(text: string): boolean {
  return text.trim() !== "";
}
