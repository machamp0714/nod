import type { PrReviewDecision, PrState, PrStatus } from "../api/types";
import type { IconName } from "../components/ui/Icon";
import type { Tone } from "./meta";

// PR 状態（#67）のピルの中身。nod.pen の「Issue詳細｜PR状態」「PR状態｜状態一覧」に合わせる
export interface PillSpec {
  label: string;
  icon: IconName;
  tone: Tone;
}

const STATE_PILLS: Record<PrState, PillSpec> = {
  OPEN: { label: "Open", icon: "git-pull-request", tone: "ready" },
  MERGED: { label: "Merged", icon: "git-merge", tone: "accent" },
  CLOSED: { label: "Closed", icon: "git-pull-request-closed", tone: "fail" },
};
const DRAFT_PILL: PillSpec = { label: "Draft", icon: "git-pull-request-draft", tone: "gate" };

const REVIEW_PILLS: Record<PrReviewDecision, PillSpec> = {
  APPROVED: { label: "承認済み", icon: "check", tone: "ready" },
  CHANGES_REQUESTED: { label: "変更要求", icon: "file-diff", tone: "ask" },
  REVIEW_REQUIRED: { label: "レビュー待ち", icon: "eye", tone: "gate" },
};

export function prStatePill(s: PrStatus): PillSpec {
  return s.state === "OPEN" && s.isDraft ? DRAFT_PILL : STATE_PILLS[s.state];
}

// レビュー必須でない PR（gh が空を返す）はピルを出さない
export function reviewPill(s: PrStatus): PillSpec | null {
  return s.reviewDecision ? REVIEW_PILLS[s.reviewDecision] : null;
}

export function ciPill(s: PrStatus): { text: string; tone: Tone; title: string } | null {
  if (s.checks.length === 0) return null;
  const c = s.checkSummary;
  const parts: [number, string][] = [
    [c.success, "✓"],
    [c.failure, "✗"],
    [c.pending, "⋯"],
  ];
  const text = parts.filter(([n]) => n > 0).map(([n, mark]) => `${mark}${n}`).join(" ");
  return {
    text: text || `スキップ ${c.skipped}`,
    tone: c.failure > 0 ? "fail" : c.pending > 0 ? "ask" : "ready",
    title: `成功 ${c.success} / 失敗 ${c.failure} / 実行中 ${c.pending} / スキップ ${c.skipped}`,
  };
}
