import type { ActivityItem, WorkLogKind } from "../api/types";

// nod.pen「Issue詳細｜作業ログ」。種類の順と文言は core の WORK_LOG_KIND_LABEL と同じにする（web は core の値を import しない）。
// 方針・実行コマンド・結果の色は nod.pen に無いため、PM の承認で中立色（sunken 背景・ink2 文字・ink3 の点）にした
export type WorkLogTone = "accent" | "gate" | "ready" | "ask" | "neutral";

export const WORK_LOG_KIND_META: Record<WorkLogKind, { label: string; tone: WorkLogTone }> = {
  progress: { label: "経過", tone: "accent" },
  plan: { label: "方針", tone: "neutral" },
  rationale: { label: "判断根拠", tone: "gate" },
  command: { label: "実行コマンド・結果", tone: "neutral" },
  test: { label: "テスト結果", tone: "ready" },
  blocker: { label: "ブロッカー", tone: "ask" },
};

export const WORK_LOG_TONE_COLORS: Record<WorkLogTone, { fg: string; bg: string; dot: string }> = {
  accent: { fg: "var(--accent)", bg: "var(--accent-soft)", dot: "var(--accent)" },
  gate: { fg: "var(--gate)", bg: "var(--gate-soft)", dot: "var(--gate)" },
  ready: { fg: "var(--ready)", bg: "var(--ready-soft)", dot: "var(--ready)" },
  ask: { fg: "var(--ask)", bg: "var(--ask-soft)", dot: "var(--ask)" },
  neutral: { fg: "var(--ink2)", bg: "var(--sunken)", dot: "var(--ink3)" },
};

// Activity の絞り込み。all は今までどおりすべて、log は種類付きのコメント（作業ログ）だけ、種類はその種類だけ
export type WorkLogFilter = "all" | "log" | WorkLogKind;

const KINDS = Object.keys(WORK_LOG_KIND_META) as WorkLogKind[];

export const WORK_LOG_FILTERS: readonly { key: WorkLogFilter; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "log", label: "作業ログ" },
  ...KINDS.map((kind) => ({ key: kind, label: WORK_LOG_KIND_META[kind].label })),
];

export function filterActivity(items: readonly ActivityItem[], filter: WorkLogFilter): ActivityItem[] {
  if (filter === "all") return [...items];
  return items.filter((item) => item.kind === "comment" && item.logKind !== null && (filter === "log" || item.logKind === filter));
}

// コマンドの出力とテスト結果は等幅で、桁や字下げを崩さずに出す
export function isMonoWorkLog(kind: WorkLogKind | null): boolean {
  return kind === "command" || kind === "test";
}
