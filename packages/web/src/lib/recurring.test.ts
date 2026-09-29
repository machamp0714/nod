import { describe, expect, test } from "bun:test";
import type { RecurringIssue, RecurringRun } from "../api/types";
import { cadenceLabel, formatNext, formFromRecurring, inputFromForm, newRecurringForm, recurringFormError, runToast, templateMissing, WEEKDAY_ORDER } from "./recurring";

const base: RecurringIssue = {
  id: 1,
  workspaceKey: "API",
  title: "週次レビュー",
  description: null,
  template: "review",
  project: "運用",
  labels: ["review"],
  priority: 3,
  assignee: "me",
  cadence: "weekly",
  weekday: 1,
  monthDay: null,
  startDate: "2026-10-05",
  timeZone: "Asia/Tokyo",
  enabled: true,
  lastOccurrence: null,
  lastIssueId: null,
  nextOccurrence: "2026-10-05",
  createdBy: "me",
  createdAt: "",
  updatedBy: "me",
  updatedAt: "",
};

describe("定期Issueの表示", () => {
  test("周期を日本語で出す（29日以降は月末扱い、31 は末日）", () => {
    expect(cadenceLabel({ cadence: "daily", weekday: null, monthDay: null })).toBe("毎日");
    expect(cadenceLabel({ cadence: "weekly", weekday: 1, monthDay: null })).toBe("毎週 月曜");
    expect(cadenceLabel({ cadence: "weekly", weekday: 0, monthDay: null })).toBe("毎週 日曜");
    expect(cadenceLabel({ cadence: "monthly", weekday: null, monthDay: 15 })).toBe("毎月 15日");
    expect(cadenceLabel({ cadence: "monthly", weekday: null, monthDay: 31 })).toBe("毎月 末日");
  });

  test("曜日は月曜始まりで並べる", () => {
    expect(WEEKDAY_ORDER.map((d) => d.label).join("")).toBe("月火水木金土日");
  });

  test("次回は MM/DD、無ければダッシュ", () => {
    expect(formatNext("2026-10-05")).toBe("10/05");
    expect(formatNext(null)).toBe("—");
  });

  test("実行後のトーストは件数とスキップ・失敗の件数を出す", () => {
    const run = (skips: number[], failures = 0): RecurringRun => ({
      workspaceKey: "API",
      dryRun: false,
      evaluatedAt: "",
      items: skips.map((skipped, i) => ({ recurringId: i, title: "", occurrence: "", skipped, issueId: `API-${i}` })),
      failed: Array.from({ length: failures }, (_, i) => ({ recurringId: 100 + i, title: "", occurrence: "", message: "" })),
    });
    expect(runToast(run([0, 3]))).toBe("2件を起票しました（スキップ 3件）");
    expect(runToast(run([0]))).toBe("1件を起票しました");
    expect(runToast(run([]))).toBe("起票する定期Issueはありませんでした");
    expect(runToast(run([], 2))).toBe("起票できませんでした（失敗 2件）");
    expect(runToast(run([0, 3], 1))).toBe("2件を起票しました（スキップ 3件・失敗 1件）");
    expect(runToast(run([0], 1))).toBe("1件を起票しました（失敗 1件）");
  });

  test("テンプレート欠落は、失敗した定期Issueのテンプレート名を引く", () => {
    const run: RecurringRun = {
      workspaceKey: "API",
      dryRun: true,
      evaluatedAt: "",
      items: [],
      failed: [{ recurringId: 1, title: "週次レビュー", occurrence: "2026-10-05", message: "テンプレート review はありません" }],
    };
    expect(templateMissing(run, [base])).toEqual([{ recurringId: 1, template: "review", message: "テンプレート review はありません" }]);
  });
});

describe("定期Issueのフォーム", () => {
  test("新規は毎週・月曜・今日・ブラウザの TZ から始める", () => {
    const f = newRecurringForm("2026-09-30", "Asia/Tokyo");
    expect(f).toMatchObject({ title: "", bodyMode: "description", cadence: "weekly", weekday: 1, monthDay: 1, startDate: "2026-09-30", timeZone: "Asia/Tokyo" });
  });

  test("既存の値からフォームを作り、送る値に戻せる", () => {
    const f = formFromRecurring(base);
    expect(f).toMatchObject({ bodyMode: "template", template: "review", project: "運用", labels: ["review"], weekday: 1 });
    expect(inputFromForm(f)).toEqual({
      title: "週次レビュー",
      description: null,
      template: "review",
      project: "運用",
      labels: ["review"],
      priority: 3,
      assignee: "me",
      cadence: "weekly",
      weekday: 1,
      monthDay: null,
      startDate: "2026-10-05",
      timeZone: "Asia/Tokyo",
    });
  });

  test("本文モードは空の本文を null にし、毎日は曜日と日を送らない", () => {
    const f = { ...newRecurringForm("2026-09-30", "UTC"), title: "a", cadence: "daily" as const, description: " ", project: "", assignee: "" };
    expect(inputFromForm(f)).toMatchObject({ description: null, template: null, project: null, assignee: null, weekday: null, monthDay: null });
  });

  test("タイトル・テンプレート・開始日の未入力を検出する", () => {
    const f = newRecurringForm("2026-09-30", "UTC");
    expect(recurringFormError(f)).toBe("タイトルを入力してください");
    expect(recurringFormError({ ...f, title: "a", bodyMode: "template", template: "" })).toBe("テンプレートを選んでください");
    expect(recurringFormError({ ...f, title: "a", startDate: "" })).toBe("開始日を入力してください");
    expect(recurringFormError({ ...f, title: "a" })).toBeNull();
  });
});
