// 作業ログ（nod issue log）の種類。内部推論は集めず、作業要約・判断根拠・実行結果を種類別に残す。
// 種類は comments.log_kind に英語キーで保存し、表示では日本語のラベルにする。通常のコメントと既存のログは NULL（種類なし）
export const WORK_LOG_KINDS = ["progress", "plan", "rationale", "command", "test", "blocker"] as const;
export type WorkLogKind = (typeof WORK_LOG_KINDS)[number];

export const WORK_LOG_KIND_LABEL: Record<WorkLogKind, string> = {
  progress: "経過",
  plan: "方針",
  rationale: "判断根拠",
  command: "実行コマンド・結果",
  test: "テスト結果",
  blocker: "ブロッカー",
};

export const DEFAULT_WORK_LOG_KIND: WorkLogKind = "progress";

// 長い出力は要点だけをログに残し、全文は Document に置く
export const WORK_LOG_MAX_LENGTH = 4000;

export function isWorkLogKind(value: string): value is WorkLogKind {
  return (WORK_LOG_KINDS as readonly string[]).includes(value);
}

// 既知の形の秘密値だけを見つける。見つけた値そのものは返さず、種類の名前だけを返す
const SECRET_PATTERNS: [string, RegExp][] = [
  ["GitHub のトークン", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["API キー（sk-）", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["AWS のアクセスキー", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Slack のトークン", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["秘密鍵", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

export function detectSecret(text: string): string | null {
  for (const [name, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return null;
}
