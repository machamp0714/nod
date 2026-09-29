import { describe, expect, test } from "bun:test";
import type { AutomationRuleResult, AutomationRun, AutomationSettings } from "../api/types";
import {
  automationDraft,
  automationEditState,
  confirmTitle,
  hasRunnableRule,
  formatEvaluatedAt,
  formatSinceDate,
  prNumberLabel,
  ruleDaysInvalid,
  recurringHeading,
  ruleHeading,
  runTargets,
  runToast,
} from "./automation";

const saved = (close: number | null, archive: number | null, prReview = false): AutomationSettings => ({
  workspaceKey: "API",
  closeAfterDays: close,
  archiveAfterDays: archive,
  prReview,
  commitReview: false,
  updatedAt: null,
  updatedBy: null,
});

const rule = (kind: "auto_close" | "auto_archive" | "pr_review", candidates: number, processed: number, failed = 0, skipped = 0): AutomationRuleResult => ({
  kind,
  days: 10,
  enabled: true,
  total: candidates,
  candidates: Array.from({ length: candidates }, (_, i) => ({ id: `API-${i}`, title: "t", status: "todo" as const, since: "", elapsedDays: 1 })),
  processed: Array.from({ length: processed }, (_, i) => `API-${i}`),
  skipped: Array.from({ length: skipped }, (_, i) => `API-${i}`),
  failed: Array.from({ length: failed }, (_, i) => ({ id: `API-${i}`, message: "x" })),
  remaining: 0,
});

describe("自動化の編集状態", () => {
  test("未設定なら両ルール OFF で、既定の日数を入れておく", () => {
    expect(automationDraft(saved(null, null))).toEqual({
      close: { enabled: false, days: "30" },
      archive: { enabled: false, days: "14" },
      prReview: false,
      commitReview: false,
    });
    expect(automationDraft(saved(90, 7, true))).toEqual({
      close: { enabled: true, days: "90" },
      archive: { enabled: true, days: "7" },
      prReview: true,
      commitReview: false,
    });
  });

  test("有効なルールの日数は 1〜3650 の整数。無効なルールは問わない", () => {
    for (const days of ["0", "3651", "1.5", "", "abc", "-1"]) expect(ruleDaysInvalid({ enabled: true, days })).toBe(true);
    for (const days of ["1", "3650", " 30 "]) expect(ruleDaysInvalid({ enabled: true, days })).toBe(false);
    expect(ruleDaysInvalid({ enabled: false, days: "0" })).toBe(false);
  });

  test("保存済みと同じなら保存できず、変わっていて正しければ保存できる", () => {
    const s = saved(30, null);
    expect(automationEditState(automationDraft(s), s).canSave).toBe(false);
    const on = automationEditState({ close: { enabled: true, days: "30" }, archive: { enabled: true, days: "14" }, prReview: false, commitReview: false }, s);
    expect(on).toMatchObject({ dirty: true, canSave: true, input: { closeAfterDays: 30, archiveAfterDays: 14 } });
    const off = automationEditState({ close: { enabled: false, days: "30" }, archive: { enabled: false, days: "14" }, prReview: false, commitReview: false }, s);
    expect(off.input).toEqual({ closeAfterDays: null, archiveAfterDays: null, prReview: false, commitReview: false });
    const bad = automationEditState({ close: { enabled: true, days: "0" }, archive: { enabled: false, days: "14" }, prReview: false, commitReview: false }, s);
    expect(bad).toMatchObject({ closeInvalid: true, archiveInvalid: false, canSave: false });
    // PR 連動だけを切り替えても保存できる
    const pr = automationEditState({ ...automationDraft(s), prReview: true }, s);
    expect(pr).toMatchObject({ dirty: true, canSave: true, input: { closeAfterDays: 30, archiveAfterDays: null, prReview: true } });
    const commit = automationEditState({ ...automationDraft(s), commitReview: true }, s);
    expect(commit).toMatchObject({ dirty: true, canSave: true, input: { commitReview: true, prReview: false } });
  });
});

describe("自動化の表示", () => {
  const off = { ...rule("pr_review", 0, 0), days: null, enabled: false };
  const noRecurring = { enabled: 0, items: [], notRun: [], failed: [] };
  const run = (
    close: ReturnType<typeof rule>,
    archive: ReturnType<typeof rule>,
    pr: ReturnType<typeof rule> = off,
    recurring: AutomationRun["recurring"] = noRecurring,
  ): AutomationRun => ({
    evaluatedAt: "",
    workspaceKey: "API",
    dryRun: true,
    rules: [close, archive, pr],
    recurring,
  });
  const item = (recurringId: number) => ({ recurringId, title: "日次", occurrence: "2026-09-30", skipped: 0, issueId: null });

  test("確認ダイアログは今回扱う件数、トーストは処理・失敗の件数", () => {
    expect(confirmTitle(run(rule("auto_close", 5, 0), rule("auto_archive", 3, 0)))).toBe("クローズ 5件・アーカイブ 3件を実行しますか？");
    expect(runToast(run(rule("auto_close", 5, 4, 1), rule("auto_archive", 3, 3)))).toBe("クローズ 4件・アーカイブ 3件・失敗 1件");
    expect(runToast(run(rule("auto_close", 5, 3, 0, 2), rule("auto_archive", 3, 2, 0, 1)))).toBe(
      "クローズ 3件・アーカイブ 2件・スキップ 3件・失敗 0件",
    );
    // PR 連動が有効なときだけ in_review の件数を足す
    const pr = { ...rule("pr_review", 2, 1), days: null };
    expect(confirmTitle(run(rule("auto_close", 0, 0), rule("auto_archive", 0, 0), pr))).toBe(
      "クローズ 0件・アーカイブ 0件・in_review 2件を実行しますか？",
    );
    expect(runToast(run(rule("auto_close", 0, 0), rule("auto_archive", 0, 0), pr))).toBe("クローズ 0件・アーカイブ 0件・in_review 1件・失敗 0件");
  });

  test("定期Issue（#32）が有効なら、確認ダイアログとトーストに起票の件数を先頭に足す", () => {
    const recurring = { enabled: 2, items: [item(1), item(2)], notRun: [], failed: [] };
    expect(confirmTitle(run(rule("auto_close", 1, 0), rule("auto_archive", 0, 0), off, recurring))).toBe(
      "起票 2件・クローズ 1件・アーカイブ 0件を実行しますか？",
    );
    const gone = { recurringId: 2, reason: "実行時には起票済み・停止中・削除済みでした" };
    const done = { enabled: 2, items: [item(1)], notRun: [gone], failed: [{ recurringId: 3, title: "t", occurrence: "2026-09-30", message: "x" }] };
    expect(runToast(run(rule("auto_close", 1, 1), rule("auto_archive", 0, 0), off, done))).toBe(
      "起票 1件・クローズ 1件・アーカイブ 0件・スキップ 1件・失敗 1件",
    );
  });

  test("確認後に発生日が変わった定期Issueは、トーストのスキップに理由と件数を添える", () => {
    const changed = (recurringId: number) => ({ recurringId, reason: "確認後に発生日が変わりました" });
    const gone = { recurringId: 9, reason: "実行時には起票済み・停止中・削除済みでした" };
    const done = { enabled: 3, items: [], notRun: [changed(1), changed(2), gone], failed: [] };
    expect(runToast(run(rule("auto_close", 0, 0), rule("auto_archive", 0, 0), off, done))).toBe(
      "起票 0件・クローズ 0件・アーカイブ 0件・スキップ 3件（確認後に発生日が変わりました 2件）・失敗 0件",
    );
    expect(recurringHeading(2)).toBe("起票する（定期Issue）· 2 件");
  });

  test("有効なルールか有効な定期Issueがあれば確認・実行できる", () => {
    expect(hasRunnableRule(saved(null, null), 0)).toBe(false);
    expect(hasRunnableRule(saved(null, null), 1)).toBe(true);
    expect(hasRunnableRule(saved(30, null), 0)).toBe(true);
    expect(hasRunnableRule(saved(null, null, true), 0)).toBe(true);
  });

  test("実行は確認ダイアログで示した一覧だけを送る", () => {
    expect(runTargets(run(rule("auto_close", 2, 0), rule("auto_archive", 1, 0)))).toEqual({
      auto_close: ["API-0", "API-1"],
      auto_archive: ["API-0"],
      pr_review: [],
      recurring: [],
    });
    const recurring = { enabled: 2, items: [item(4), item(7)], notRun: [], failed: [] };
    expect(runTargets(run(rule("auto_close", 0, 0), rule("auto_archive", 0, 0), off, recurring)).recurring).toEqual([
      { recurringId: 4, occurrence: "2026-09-30" },
      { recurringId: 7, occurrence: "2026-09-30" },
    ]);
  });

  test("ルールの見出しと日時の書式", () => {
    expect(ruleHeading("auto_close", 15)).toBe("canceled にする · 15 件");
    expect(ruleHeading("auto_archive", 3)).toBe("アーカイブする · 3 件");
    expect(ruleHeading("pr_review", 2)).toBe("in_review にする（PR）· 2 件");
    expect(prNumberLabel("https://github.com/example/api/pull/214")).toBe("#214");
    expect(prNumberLabel("https://github.com/example/api/pull/214/")).toBe("#214");
    expect(prNumberLabel(undefined)).toBe("");
    const local = new Date(2026, 8, 30, 10, 12);
    expect(formatEvaluatedAt(local.toISOString())).toBe("09-30 10:12 時点");
    expect(formatSinceDate(local.toISOString())).toBe("2026-09-30");
  });
});
