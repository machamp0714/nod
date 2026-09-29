// core の RULES_MAX_LENGTH と同じ上限。保存時は前後の空白を除くため、数えるのも除いた長さ
export const RULES_MAX_LENGTH = 10000;

export interface RulesEditState {
  length: number;
  over: boolean;
  canSave: boolean;
}

export function rulesEditState(draft: string, saved: string | null): RulesEditState {
  const trimmed = draft.trim();
  const over = trimmed.length > RULES_MAX_LENGTH;
  return { length: trimmed.length, over, canSave: !over && trimmed !== (saved ?? "") };
}

export function formatRulesCount(length: number): string {
  return `${length.toLocaleString("en-US")} / ${RULES_MAX_LENGTH.toLocaleString("en-US")} 文字`;
}

export function formatRulesUpdated(rules: { updatedAt: string; updatedBy: string }): string {
  const d = new Date(rules.updatedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const at = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `最終更新 ${at} · ${rules.updatedBy}`;
}
