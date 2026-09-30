import { describe, expect, test } from "bun:test";
import { formatTemplateUpdated, templateAddState, templateEditState } from "./templates";

describe("テンプレートの下書き（#160）", () => {
  test("追加は名前と本文がそろうと保存でき、名前は前後の空白を除き、同じ名前を知らせる", () => {
    const existing = [{ name: "bug" }];
    expect(templateAddState("", "x", existing)).toEqual({ name: "", duplicated: false, canSave: false });
    expect(templateAddState("new", " \n", existing).canSave).toBe(false);
    expect(templateAddState(" new ", "## 手順", existing)).toEqual({ name: "new", duplicated: false, canSave: true });
    expect(templateAddState(" bug ", "x", existing).duplicated).toBe(true);
    expect(templateAddState("Bug", "x", existing).duplicated).toBe(false);
  });

  test("本文は変わっていて空白だけでないときに保存できる", () => {
    expect(templateEditState("v1", "v1").canSave).toBe(false);
    expect(templateEditState(" \n", "v1").canSave).toBe(false);
    expect(templateEditState("v1\n", "v1").canSave).toBe(true);
  });

  test("更新日を暦日で出す", () => {
    expect(formatTemplateUpdated(new Date(2026, 8, 2, 9, 5).toISOString())).toBe("更新 2026-09-02");
  });
});
