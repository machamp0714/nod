import type { AutomationKind, AutomationRun, AutomationSettings, AutomationTargets } from "../api/types";

// core の AUTOMATION_DAYS_MAX と同じ上限
export const AUTOMATION_DAYS_MAX = 3650;
// 無効なルールを有効にしたときに最初に入れておく日数（nod.pen の例と同じ）
export const DEFAULT_CLOSE_DAYS = 30;
export const DEFAULT_ARCHIVE_DAYS = 14;
// core の RECURRING_CHANGED_REASON と同じ文言（確認後に定期Issueの発生日が変わって起票しなかった理由）
export const RECURRING_CHANGED_REASON = "確認後に発生日が変わりました";

export interface RuleDraft {
  enabled: boolean;
  days: string;
}

export interface AutomationDraft {
  close: RuleDraft;
  archive: RuleDraft;
  prReview: boolean; // PR 連動（#66）。日数はない
  commitReview: boolean; // コミット連動（#68）。実行は CLI の nod git sync
}

export function automationDraft(saved: AutomationSettings): AutomationDraft {
  const rule = (days: number | null, fallback: number): RuleDraft => ({ enabled: days !== null, days: String(days ?? fallback) });
  return {
    close: rule(saved.closeAfterDays, DEFAULT_CLOSE_DAYS),
    archive: rule(saved.archiveAfterDays, DEFAULT_ARCHIVE_DAYS),
    prReview: saved.prReview,
    commitReview: saved.commitReview,
  };
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
  input: { closeAfterDays: number | null; archiveAfterDays: number | null; prReview: boolean; commitReview: boolean };
}

export function automationEditState(draft: AutomationDraft, saved: AutomationSettings): AutomationEditState {
  const closeInvalid = ruleDaysInvalid(draft.close);
  const archiveInvalid = ruleDaysInvalid(draft.archive);
  const input = {
    closeAfterDays: ruleValue(draft.close),
    archiveAfterDays: ruleValue(draft.archive),
    prReview: draft.prReview,
    commitReview: draft.commitReview,
  };
  const dirty =
    input.closeAfterDays !== saved.closeAfterDays ||
    input.archiveAfterDays !== saved.archiveAfterDays ||
    input.prReview !== saved.prReview ||
    input.commitReview !== saved.commitReview;
  return { closeInvalid, archiveInvalid, dirty, canSave: dirty && !closeInvalid && !archiveInvalid, input };
}

// 確認・実行できるのは、有効な自動化ルールか有効な定期Issue（#32）があるとき。コミット連動は nod git sync で実行する
export function hasRunnableRule(saved: AutomationSettings, enabledRecurring: number): boolean {
  return saved.closeAfterDays !== null || saved.archiveAfterDays !== null || saved.prReview || enabledRecurring > 0;
}

// 実行する件数（上限までの今回分）
export function runCounts(run: AutomationRun): { recurring: number; close: number; archive: number; prReview: number } {
  const count = (kind: string) => run.rules.find((r) => r.kind === kind)?.candidates.length ?? 0;
  return { recurring: run.recurring.items.length, close: count("auto_close"), archive: count("auto_archive"), prReview: count("pr_review") };
}

// PR 連動（#66）が有効なときだけ in_review の件数を示す
const prReviewEnabled = (run: AutomationRun) => run.rules.some((r) => r.kind === "pr_review" && r.enabled);
// 有効な定期Issue（#32）があるときだけ起票の件数を示す
const recurringEnabled = (run: AutomationRun) => run.recurring.enabled > 0;

export function confirmTitle(run: AutomationRun): string {
  const { recurring, close, archive, prReview } = runCounts(run);
  const head = recurringEnabled(run) ? `起票 ${recurring}件・` : "";
  return `${head}クローズ ${close}件・アーカイブ ${archive}件${prReviewEnabled(run) ? `・in_review ${prReview}件` : ""}を実行しますか？`;
}

// 確認ダイアログで示した一覧。実行はこの範囲だけを処理する
export function runTargets(run: AutomationRun): AutomationTargets {
  const ids = (kind: string) => run.rules.find((r) => r.kind === kind)?.candidates.map((c) => c.id) ?? [];
  return {
    auto_close: ids("auto_close"),
    auto_archive: ids("auto_archive"),
    pr_review: ids("pr_review"),
    // 確認時点の発生日も送り、実行時の発生日と違えば起票しない（23:59 に確認して 00:01 に実行したときなど）
    recurring: run.recurring.items.map((i) => ({ recurringId: i.recurringId, occurrence: i.occurrence })),
  };
}

// スキップ（確認のあとで対象から外れたもの）はあるときだけ示す
export function runToast(run: AutomationRun): string {
  const processed = (kind: string) => run.rules.find((r) => r.kind === kind)?.processed.length ?? 0;
  const skipped = run.rules.reduce((n, r) => n + r.skipped.length, run.recurring.notRun.length);
  const failed = run.rules.reduce((n, r) => n + r.failed.length, run.recurring.failed.length);
  const head = recurringEnabled(run) ? `起票 ${run.recurring.items.length}件・` : "";
  const pr = prReviewEnabled(run) ? `・in_review ${processed("pr_review")}件` : "";
  const changed = run.recurring.notRun.filter((n) => n.reason === RECURRING_CHANGED_REASON).length;
  const skip = skipped ? `・スキップ ${skipped}件${changed ? `（${RECURRING_CHANGED_REASON} ${changed}件）` : ""}` : "";
  return `${head}クローズ ${processed("auto_close")}件・アーカイブ ${processed("auto_archive")}件${pr}${skip}・失敗 ${failed}件`;
}

export function ruleHeading(kind: AutomationKind, total: number): string {
  if (kind === "pr_review") return `in_review にする（PR）· ${total} 件`;
  return `${kind === "auto_close" ? "canceled にする" : "アーカイブする"} · ${total} 件`;
}

export function recurringHeading(total: number): string {
  return `起票する（定期Issue）· ${total} 件`;
}

// PR 連動の対象一覧の PR 列。GitHub の PR URL の末尾の番号（#214）
export function prNumberLabel(url: string | undefined): string {
  const m = url ? /\/pull\/(\d+)\/?$/.exec(url) : null;
  return m ? `#${m[1]}` : "";
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
