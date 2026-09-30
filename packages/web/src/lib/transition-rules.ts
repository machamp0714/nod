import type { Status, TransitionPreset, WorkspaceTransitionRules } from "../api/types";
import { STATUS_META, STATUS_ORDER } from "./meta";
import type { StatusNames } from "./workspace-labels";

// ステータスの遷移ルール（#73）。core の transition-rules と同じ決まり（サーバーでも同じ検証をする）

// needs_clarification は確認依頼に応じて core が切り替えるため、ルールに指定できない
export const RULE_STATUSES: Status[] = STATUS_ORDER.filter((s) => s !== "needs_clarification");

export const REVIEW_BEFORE_DONE: TransitionPreset = "review_before_done";

// 塞ぐとレビュー依頼・承認・差し戻し・Triage の判断ができなくなる遷移
const PROTECTED_PAIRS: { from: Status; to: Status; why: string }[] = [
  { from: "in_review", to: "done", why: "レビュー承認に必要" },
  { from: "in_progress", to: "in_review", why: "レビュー依頼（nod issue done）に必要" },
  { from: "in_review", to: "in_progress", why: "レビューの差し戻しに必要" },
  { from: "triage", to: "todo", why: "Triage の受け入れに必要" },
  { from: "triage", to: "canceled", why: "Triage の却下・重複に必要" },
];

export interface TransitionPairDraft {
  from: Status;
  to: Status;
}

export interface TransitionRulesDraft {
  forbidden: TransitionPairDraft[];
  reviewBeforeDone: boolean;
}

export function transitionRulesDraft(saved: WorkspaceTransitionRules): TransitionRulesDraft {
  return { forbidden: saved.forbidden.map((p) => ({ ...p })), reviewBeforeDone: saved.presets.includes(REVIEW_BEFORE_DONE) };
}

// 追加する行の初期値。まだ使っていない組のうち、状態の順で最初のもの
export function nextPair(rows: TransitionPairDraft[]): TransitionPairDraft {
  for (const from of RULE_STATUSES) {
    for (const to of RULE_STATUSES) {
      if (from === to || PROTECTED_PAIRS.some((p) => p.from === from && p.to === to)) continue;
      if (!rows.some((r) => r.from === from && r.to === to)) return { from, to };
    }
  }
  return { from: "backlog", to: "done" };
}

const pairKey = (p: TransitionPairDraft) => `${p.from}:${p.to}`;

export function transitionRulesEditState(draft: TransitionRulesDraft, saved: WorkspaceTransitionRules, names: StatusNames = {}) {
  const label = (s: Status) => names[s] ?? STATUS_META[s].label;
  const invalidRows: number[] = [];
  let error = null as string | null;
  const fail = (i: number, message: string) => {
    invalidRows.push(i);
    error ??= message;
  };
  draft.forbidden.forEach((row, i) => {
    if (row.from === row.to) return fail(i, "同じステータスへの遷移は指定できません");
    const guarded = PROTECTED_PAIRS.find((p) => p.from === row.from && p.to === row.to);
    if (guarded) return fail(i, `${label(row.from)} → ${label(row.to)} は禁止できません（${guarded.why}）`);
    if (draft.forbidden.findIndex((r) => pairKey(r) === pairKey(row)) !== i) {
      return fail(i, `${label(row.from)} → ${label(row.to)} が重なっています`);
    }
  });
  const presets: TransitionPreset[] = draft.reviewBeforeDone ? [REVIEW_BEFORE_DONE] : [];
  const input = { forbidden: draft.forbidden.map((r) => ({ from: r.from, to: r.to })), presets };
  const savedKeys = saved.forbidden.map(pairKey).sort().join(",");
  const draftKeys = [...new Set(draft.forbidden.map(pairKey))].sort().join(",");
  const changed = savedKeys !== draftKeys || draft.reviewBeforeDone !== saved.presets.includes(REVIEW_BEFORE_DONE);
  const empty = draft.forbidden.length === 0 && !draft.reviewBeforeDone;
  return { input, invalidRows, error, changed, empty, canSave: changed && error === null };
}
