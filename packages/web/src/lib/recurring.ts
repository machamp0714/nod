import type { RecurrenceCadence, RecurringIssue, RecurringIssueInput, RecurringRun } from "../api/types";

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

// フォームの曜日ボタンは月曜始まり（value は 0 = 日曜）
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0].map((value) => ({ value, label: WEEKDAY_LABELS[value]! }));

// 毎月の日。29〜31 はその日が無い月は月末になる。31 は「末日」と出す
export const MONTH_DAY_CHOICES = Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: i === 30 ? "末日" : `${i + 1}日` }));

export const CADENCE_CHOICES: { value: RecurrenceCadence; label: string }[] = [
  { value: "daily", label: "毎日" },
  { value: "weekly", label: "毎週" },
  { value: "monthly", label: "毎月" },
];

export function cadenceLabel(r: Pick<RecurringIssue, "cadence" | "weekday" | "monthDay">): string {
  if (r.cadence === "daily") return "毎日";
  if (r.cadence === "weekly") return `毎週 ${WEEKDAY_LABELS[r.weekday ?? 0]}曜`;
  return r.monthDay === 31 ? "毎月 末日" : `毎月 ${r.monthDay}日`;
}

export function formatNext(date: string | null): string {
  return date ? `${date.slice(5, 7)}/${date.slice(8, 10)}` : "—";
}

export type LastCreated = { kind: "issue"; issueId: string } | { kind: "deleted"; date: string; title: string } | { kind: "none" };

// 前回作成の列（#145）。最新回の Issue を永久削除すると lastIssueId は null になるので、起票日（lastOccurrence）で未実行と見分ける
export function lastCreated(r: Pick<RecurringIssue, "lastOccurrence" | "lastIssueId">): LastCreated {
  if (r.lastIssueId) return { kind: "issue", issueId: r.lastIssueId };
  if (r.lastOccurrence) {
    return { kind: "deleted", date: formatNext(r.lastOccurrence), title: `${r.lastOccurrence} に起票した Issue は削除されました` };
  }
  return { kind: "none" };
}

export function runToast(run: RecurringRun): string {
  const failed = run.failed.length;
  if (run.items.length === 0) return failed ? `起票できませんでした（失敗 ${failed}件）` : "起票する定期Issueはありませんでした";
  const skipped = run.items.reduce((sum, i) => sum + i.skipped, 0);
  const notes = [skipped ? `スキップ ${skipped}件` : "", failed ? `失敗 ${failed}件` : ""].filter(Boolean);
  return `${run.items.length}件を起票しました${notes.length ? `（${notes.join("・")}）` : ""}`;
}

// 起票できなかった定期Issue。テンプレート名は一覧から引く（消えたテンプレートの名前を見せるため）
export function templateMissing(run: RecurringRun, list: RecurringIssue[]): { recurringId: number; template: string | null; message: string }[] {
  return run.failed.map((f) => ({
    recurringId: f.recurringId,
    template: list.find((r) => r.id === f.recurringId)?.template ?? null,
    message: f.message,
  }));
}

export interface RecurringForm {
  title: string;
  bodyMode: "description" | "template";
  description: string;
  template: string;
  project: string; // 空文字は Project なし
  labels: string[];
  priority: number;
  assignee: string; // 空文字は担当なし
  cadence: RecurrenceCadence;
  weekday: number;
  monthDay: number;
  startDate: string;
  timeZone: string;
}

export function newRecurringForm(today: string, timeZone: string): RecurringForm {
  return {
    title: "",
    bodyMode: "description",
    description: "",
    template: "",
    project: "",
    labels: [],
    priority: 0,
    assignee: "",
    cadence: "weekly",
    weekday: 1,
    monthDay: 1,
    startDate: today,
    timeZone,
  };
}

export function formFromRecurring(r: RecurringIssue): RecurringForm {
  return {
    title: r.title,
    bodyMode: r.template !== null ? "template" : "description",
    description: r.description ?? "",
    template: r.template ?? "",
    project: r.project ?? "",
    labels: r.labels,
    priority: r.priority,
    assignee: r.assignee ?? "",
    cadence: r.cadence,
    weekday: r.weekday ?? 1,
    monthDay: r.monthDay ?? 1,
    startDate: r.startDate,
    timeZone: r.timeZone,
  };
}

export function inputFromForm(f: RecurringForm): RecurringIssueInput {
  const template = f.bodyMode === "template";
  return {
    title: f.title,
    description: template || !f.description.trim() ? null : f.description,
    template: template ? f.template : null,
    project: f.project || null,
    labels: f.labels,
    priority: f.priority,
    assignee: f.assignee.trim() || null,
    cadence: f.cadence,
    weekday: f.cadence === "weekly" ? f.weekday : null,
    monthDay: f.cadence === "monthly" ? f.monthDay : null,
    startDate: f.startDate,
    timeZone: f.timeZone,
  };
}

export function recurringFormError(f: RecurringForm): string | null {
  if (!f.title.trim()) return "タイトルを入力してください";
  if (f.bodyMode === "template" && !f.template) return "テンプレートを選んでください";
  if (!f.startDate) return "開始日を入力してください";
  return null;
}
