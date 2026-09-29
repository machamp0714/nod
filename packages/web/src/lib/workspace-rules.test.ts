import { describe, expect, test } from "bun:test";
import { formatRulesCount, formatRulesUpdated, RULES_MAX_LENGTH, rulesEditState } from "./workspace-rules";

describe("作業規約の編集状態", () => {
  test("文字数は core と同じくコードポイントで数える", () => {
    expect(rulesEditState("😀".repeat(10000), null)).toMatchObject({ length: 10000, over: false });
    expect(rulesEditState("😀".repeat(10001), null)).toMatchObject({ length: 10001, over: true });
  });

  test("上限は 10,000 文字で、前後の空白を除いた長さで数える", () => {
    expect(RULES_MAX_LENGTH).toBe(10000);
    expect(rulesEditState("  abc \n", null).length).toBe(3);
    expect(formatRulesCount(10012)).toBe("10,012 / 10,000 文字");
    expect(formatRulesCount(0)).toBe("0 / 10,000 文字");
  });

  test("保存済みと同じなら保存できない", () => {
    expect(rulesEditState("", null).canSave).toBe(false);
    expect(rulesEditState("a", "a").canSave).toBe(false);
    expect(rulesEditState("a\n", "a").canSave).toBe(false);
    expect(rulesEditState("b", "a").canSave).toBe(true);
    expect(rulesEditState("a", null).canSave).toBe(true);
  });

  test("上限を超えると保存できず over になる", () => {
    const over = rulesEditState("a".repeat(10001), null);
    expect(over.over).toBe(true);
    expect(over.canSave).toBe(false);
    expect(rulesEditState("a".repeat(10000), null).over).toBe(false);
  });

  test("最終更新はローカル時刻の YYYY-MM-DD HH:mm と書き手", () => {
    const local = new Date(2026, 8, 29, 23, 5);
    expect(formatRulesUpdated({ updatedAt: local.toISOString(), updatedBy: "me" })).toBe("最終更新 2026-09-29 23:05 · me");
  });
});
