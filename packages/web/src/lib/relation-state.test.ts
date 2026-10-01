import { describe, expect, test } from "bun:test";
import { relationMark } from "./relation-state";

describe("relationMark", () => {
  test("アーカイブ済みの相手は、どの関係でも印を付ける", () => {
    for (const key of ["blocks", "blockedBy", "related", "duplicateOf", "duplicates"] as const) {
      expect(relationMark(key, { status: "todo", archived: true })).toBe("アーカイブ済み");
    }
  });

  test("Blocked by の相手が完了・キャンセルなら、数えない理由を印にする", () => {
    expect(relationMark("blockedBy", { status: "done", archived: false })).toBe("完了");
    expect(relationMark("blockedBy", { status: "canceled", archived: false })).toBe("キャンセル");
    expect(relationMark("blockedBy", { status: "in_progress", archived: false })).toBeNull();
  });

  test("アーカイブ済みは完了・キャンセルより優先する", () => {
    expect(relationMark("blockedBy", { status: "done", archived: true })).toBe("アーカイブ済み");
  });

  test("Blocked by 以外では、完了・キャンセルの印を付けない", () => {
    for (const key of ["blocks", "related", "duplicateOf", "duplicates"] as const) {
      expect(relationMark(key, { status: "done", archived: false })).toBeNull();
      expect(relationMark(key, { status: "canceled", archived: false })).toBeNull();
    }
  });

  test("状態が分からない相手には印を付けない", () => {
    expect(relationMark("blockedBy", undefined)).toBeNull();
  });
});
