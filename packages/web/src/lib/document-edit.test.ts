import { describe, expect, test } from "bun:test";
import { shouldStartEditing } from "./document-edit";

// bun test には DOM がないので、closest だけを持つ偽の要素で試す
const el = (inside: string | null) => ({ closest: (sel: string) => (inside && sel.includes(inside) ? {} : null) }) as unknown as Element;

describe("shouldStartEditing", () => {
  test("リンク・入力の内側、テキスト選択中は編集に入らない", () => {
    expect(shouldStartEditing(el(null), { isCollapsed: true })).toBe(true);
    expect(shouldStartEditing(el(null), null)).toBe(true);
    expect(shouldStartEditing(el("a"), { isCollapsed: true })).toBe(false);
    expect(shouldStartEditing(el("input"), { isCollapsed: true })).toBe(false);
    expect(shouldStartEditing(el(null), { isCollapsed: false })).toBe(false);
    expect(shouldStartEditing(null, null)).toBe(false);
  });
});
