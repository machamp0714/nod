import { describe, expect, test } from "bun:test";
import type { AutomationRun, AutomationSettings } from "../api/types";
import {
  automationDraft,
  automationEditState,
  confirmTitle,
  formatEvaluatedAt,
  formatSinceDate,
  ruleDaysInvalid,
  ruleHeading,
  runToast,
} from "./automation";

const saved = (close: number | null, archive: number | null): AutomationSettings => ({
  workspaceKey: "API",
  closeAfterDays: close,
  archiveAfterDays: archive,
  updatedAt: null,
  updatedBy: null,
});

const rule = (kind: "auto_close" | "auto_archive", candidates: number, processed: number, failed = 0) => ({
  kind,
  days: 10,
  enabled: true,
  total: candidates,
  candidates: Array.from({ length: candidates }, (_, i) => ({ id: `API-${i}`, title: "t", status: "todo" as const, since: "", elapsedDays: 1 })),
  processed: Array.from({ length: processed }, (_, i) => `API-${i}`),
  failed: Array.from({ length: failed }, (_, i) => ({ id: `API-${i}`, message: "x" })),
  remaining: 0,
});

describe("自動化の編集状態", () => {
  test("未設定なら両ルール OFF で、既定の日数を入れておく", () => {
    expect(automationDraft(saved(null, null))).toEqual({ close: { enabled: false, days: "30" }, archive: { enabled: false, days: "14" } });
    expect(automationDraft(saved(90, 7))).toEqual({ close: { enabled: true, days: "90" }, archive: { enabled: true, days: "7" } });
  });

  test("有効なルールの日数は 1〜3650 の整数。無効なルールは問わない", () => {
    for (const days of ["0", "3651", "1.5", "", "abc", "-1"]) expect(ruleDaysInvalid({ enabled: true, days })).toBe(true);
    for (const days of ["1", "3650", " 30 "]) expect(ruleDaysInvalid({ enabled: true, days })).toBe(false);
    expect(ruleDaysInvalid({ enabled: false, days: "0" })).toBe(false);
  });

  test("保存済みと同じなら保存できず、変わっていて正しければ保存できる", () => {
    const s = saved(30, null);
    expect(automationEditState(automationDraft(s), s).canSave).toBe(false);
    const on = automationEditState({ close: { enabled: true, days: "30" }, archive: { enabled: true, days: "14" } }, s);
    expect(on).toMatchObject({ dirty: true, canSave: true, input: { closeAfterDays: 30, archiveAfterDays: 14 } });
    const off = automationEditState({ close: { enabled: false, days: "30" }, archive: { enabled: false, days: "14" } }, s);
    expect(off.input).toEqual({ closeAfterDays: null, archiveAfterDays: null });
    const bad = automationEditState({ close: { enabled: true, days: "0" }, archive: { enabled: false, days: "14" } }, s);
    expect(bad).toMatchObject({ closeInvalid: true, archiveInvalid: false, canSave: false });
  });
});

describe("自動化の表示", () => {
  const run = (close: ReturnType<typeof rule>, archive: ReturnType<typeof rule>): AutomationRun => ({
    evaluatedAt: "",
    workspaceKey: "API",
    dryRun: true,
    rules: [close, archive],
  });

  test("確認ダイアログは今回扱う件数、トーストは処理・失敗の件数", () => {
    expect(confirmTitle(run(rule("auto_close", 5, 0), rule("auto_archive", 3, 0)))).toBe("クローズ 5件・アーカイブ 3件を実行しますか？");
    expect(runToast(run(rule("auto_close", 5, 4, 1), rule("auto_archive", 3, 3)))).toBe("クローズ 4件・アーカイブ 3件・失敗 1件");
  });

  test("ルールの見出しと日時の書式", () => {
    expect(ruleHeading("auto_close", 15)).toBe("canceled にする · 15 件");
    expect(ruleHeading("auto_archive", 3)).toBe("アーカイブする · 3 件");
    const local = new Date(2026, 8, 30, 10, 12);
    expect(formatEvaluatedAt(local.toISOString())).toBe("09-30 10:12 時点");
    expect(formatSinceDate(local.toISOString())).toBe("2026-09-30");
  });
});
