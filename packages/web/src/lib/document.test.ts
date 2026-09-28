import { describe, expect, test } from "bun:test";
import { parseDocumentId, stripLeadingTitle } from "./document";

describe("parseDocumentId", () => {
  test("正の整数だけを ID とする", () => {
    expect(parseDocumentId("3")).toBe(3);
    expect(parseDocumentId("0")).toBeNull();
    expect(parseDocumentId("abc")).toBeNull();
    expect(parseDocumentId("1.5")).toBeNull();
    expect(parseDocumentId("-1")).toBeNull();
  });
});

describe("stripLeadingTitle", () => {
  test("先頭の # 見出しがタイトルと同じなら省く", () => {
    expect(stripLeadingTitle("\n# 設計\n\n## 目的\n", "設計")).toBe("## 目的\n");
  });

  test("タイトルと違う見出しや、先頭でない見出しは残す", () => {
    expect(stripLeadingTitle("# 別の題\n\n本文", "設計")).toBe("# 別の題\n\n本文");
    expect(stripLeadingTitle("前書き\n\n# 設計", "設計")).toBe("前書き\n\n# 設計");
  });
});
