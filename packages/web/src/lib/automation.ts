import type { AutomationRun, AutomationSettings, AutomationTargets } from "../api/types";

// core の AUTOMATION_DAYS_MAX と同じ上限
export const AUTOMATION_DAYS_MAX = 3650;
// 無効なルールを有効にしたときに最初に入れておく日数（nod.pen の例と同じ）
export const DEFAULT_CLOSE_DAYS = 30;
export const DEFAULT_ARCHIVE_DAYS = 14;

export interface RuleDraft {
  enabled: boolean;
  days: string;
}

export interface AutomationDraft {
  close: RuleDraft;
  archive: RuleDraft;
}

export function automationDraft(saved: AutomationSettings): AutomationDraft {
  const rule = (days: number | null, fallback: number): RuleDraft => ({ enabled: days !== null, days: String(days ?? fallback) });
  return { close: rule(saved.closeAfterDays, DEFAULT_CLOSE_DAYS), archive: rule(saved.archiveAfterDays, DEFAULT_ARCHIVE_DAYS) };
}

// 有効なルールの日数が 1〜3650 の整数か。無効なルールの日数は保存しないので問わない
export function ruleDaysInvalid(rule: RuleDraft): boolean {
  if (!rule.enabled) return false;
  if (!/^[0-9]+$/.test(rule.days.trim())) return true;
  const days = Number(rule.days.trim());
  return days < 1 || days > AUTOMATION_DAYS_MAX;
}

function ruleValue(rule: RuleDraft): number | null {
  return rule.enabled ? Number(rule.days.trim()) : null;
}

export interface AutomationEditState {
  closeInvalid: boolean;
  archiveInvalid: boolean;
  dirty: boolean;
  canSave: boolean;
  input: { closeAfterDays: number | null; archiveAfterDays: number | null };
}

export function automationEditState(draft: AutomationDraft, saved: AutomationSettings): AutomationEditState {
  const closeInvalid = ruleDaysInvalid(draft.close);
  const archiveInvalid = ruleDaysInvalid(draft.archive);
  const input = { closeAfterDays: ruleValue(draft.close), archiveAfterDays: ruleValue(draft.archive) };
  const dirty = input.closeAfterDays !== saved.closeAfterDays || input.archiveAfterDays !== saved.archiveAfterDays;
  return { closeInvalid, archiveInvalid, dirty, canSave: dirty && !closeInvalid && !archiveInvalid, input };
}

// 実行する件数（上限までの今回分）
export function runCounts(run: AutomationRun): { close: number; archive: number } {
  const count = (kind: string) => run.rules.find((r) => r.kind === kind)?.candidates.length ?? 0;
  return { close: count("auto_close"), archive: count("auto_archive") };
}

export function confirmTitle(run: AutomationRun): string {
  const { close, archive } = runCounts(run);
  return `クローズ ${close}件・アーカイブ ${archive}件を実行しますか？`;
}

// 確認ダイアログで示した一覧。実行はこの範囲だけを処理する
export function runTargets(run: AutomationRun): AutomationTargets {
  const ids = (kind: string) => run.rules.find((r) => r.kind === kind)?.candidates.map((c) => c.id) ?? [];
  return { auto_close: ids("auto_close"), auto_archive: ids("auto_archive") };
}

// スキップ（確認のあとで対象から外れたもの）はあるときだけ示す
export function runToast(run: AutomationRun): string {
  const processed = (kind: string) => run.rules.find((r) => r.kind === kind)?.processed.length ?? 0;
  const skipped = run.rules.reduce((n, r) => n + r.skipped.length, 0);
  const failed = run.rules.reduce((n, r) => n + r.failed.length, 0);
  return `クローズ ${processed("auto_close")}件・アーカイブ ${processed("auto_archive")}件${skipped ? `・スキップ ${skipped}件` : ""}・失敗 ${failed}件`;
}

export function ruleHeading(kind: "auto_close" | "auto_archive", total: number): string {
  return `${kind === "auto_close" ? "canceled にする" : "アーカイブする"} · ${total} 件`;
}

const pad = (n: number) => String(n).padStart(2, "0");

// 対象を確認した時刻。ローカル時刻の MM-DD HH:mm 時点
export function formatEvaluatedAt(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 時点`;
}

// 最終更新（自動アーカイブは完了日時）。ローカル時刻の YYYY-MM-DD
export function formatSinceDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
