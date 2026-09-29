import { describe, expect, test } from "bun:test";
import type { AutomationRuleResult, AutomationRun, AutomationSettings } from "../api/types";
import {
  automationDraft,
  automationEditState,
  confirmTitle,
  formatEvaluatedAt,
  formatSinceDate,
  prNumberLabel,
  ruleDaysInvalid,
  ruleHeading,
  runTargets,
  runToast,
} from "./automation";

const saved = (close: number | null, archive: number | null, prReview = false): AutomationSettings => ({
  workspaceKey: "API",
  closeAfterDays: close,
  archiveAfterDays: archive,
  prReview,
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
    });
    expect(automationDraft(saved(90, 7, true))).toEqual({
      close: { enabled: true, days: "90" },
      archive: { enabled: true, days: "7" },
      prReview: true,
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
    const on = automationEditState({ close: { enabled: true, days: "30" }, archive: { enabled: true, days: "14" }, prReview: false }, s);
    expect(on).toMatchObject({ dirty: true, canSave: true, input: { closeAfterDays: 30, archiveAfterDays: 14 } });
    const off = automationEditState({ close: { enabled: false, days: "30" }, archive: { enabled: false, days: "14" }, prReview: false }, s);
    expect(off.input).toEqual({ closeAfterDays: null, archiveAfterDays: null, prReview: false });
    const bad = automationEditState({ close: { enabled: true, days: "0" }, archive: { enabled: false, days: "14" }, prReview: false }, s);
    expect(bad).toMatchObject({ closeInvalid: true, archiveInvalid: false, canSave: false });
    // PR 連動だけを切り替えても保存できる
    const pr = automationEditState({ ...automationDraft(s), prReview: true }, s);
    expect(pr).toMatchObject({ dirty: true, canSave: true, input: { closeAfterDays: 30, archiveAfterDays: null, prReview: true } });
  });
});

describe("自動化の表示", () => {
  const off = { ...rule("pr_review", 0, 0), days: null, enabled: false };
  const run = (close: ReturnType<typeof rule>, archive: ReturnType<typeof rule>, pr: ReturnType<typeof rule> = off): AutomationRun => ({
    evaluatedAt: "",
    workspaceKey: "API",
    dryRun: true,
    rules: [close, archive, pr],
  });

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

  test("実行は確認ダイアログで示した一覧だけを送る", () => {
    expect(runTargets(run(rule("auto_close", 2, 0), rule("auto_archive", 1, 0)))).toEqual({
      auto_close: ["API-0", "API-1"],
      auto_archive: ["API-0"],
      pr_review: [],
    });
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
