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

// 状態だけで決めるピル（draft を区別しない一覧用。自動化の PR 連動の対象一覧など）
export function prStatePillOf(state: PrState): PillSpec {
  return STATE_PILLS[state];
}

export function prStatePill(s: PrStatus): PillSpec {
  return s.state === "OPEN" && s.isDraft ? DRAFT_PILL : STATE_PILLS[s.state];
}

// レビュー必須でない PR（gh が空を返す）はピルを出さない
// 既知でない値（古いデータや将来の値）も落とさずピルを出さない
export function reviewPill(s: PrStatus): PillSpec | null {
  return (s.reviewDecision && REVIEW_PILLS[s.reviewDecision]) || null;
}

// チェックの URL は http(s) のときだけリンクにする（javascript: などを href に入れない）
export function safeCheckUrl(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
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

// nod の承認と GitHub PR の関係（#56/#57）。nod の承認は GitHub へ何も書き込まない
export const APPROVAL_NOTE = "nod の承認は GitHub の承認・マージではありません。GitHub には何も書き込みません";
export const PR_STATUS_UNFETCHED = "GitHub の状態は未取得（更新で取得）";

// 承認ボタン付近に出す注意。未マージ・変更要求を知らせるが、承認は止めない。
// 保存済みの結果は古いことがある（親の完了候補バナーには取得時刻も出ない）ので「取得時点で」と添える
export function approvalWarnings(s: PrStatus | null): string[] {
  if (!s) return [];
  const warnings: string[] = [];
  const state = prStatePill(s).label;
  if (s.state === "CLOSED") warnings.push(`取得時点で GitHub の PR はマージされずに閉じられています（${state}）`);
  else if (s.state !== "MERGED") warnings.push(`取得時点で GitHub の PR はまだマージされていません（${state}）`);
  if (s.reviewDecision === "CHANGES_REQUESTED") warnings.push("取得時点で GitHub に変更要求が出ています");
  return warnings;
}
