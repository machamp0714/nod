import { describe, expect, test } from "bun:test";
import { displayPath, normalizeIssueRef, parseDocumentId, stripLeadingTitle } from "./document";

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

describe("displayPath", () => {
  test("Documents ディレクトリの下なら相対パス、外なら絶対パスのまま", () => {
    expect(displayPath("/d/docs/specs/a.md", "/d/docs")).toBe("specs/a.md");
    expect(displayPath("/d/docs/specs/a.md", "/d/docs/")).toBe("specs/a.md");
    expect(displayPath("/d/docs2/a.md", "/d/docs")).toBe("/d/docs2/a.md");
    expect(displayPath("/x/a.md", undefined)).toBe("/x/a.md");
  });
});

describe("normalizeIssueRef", () => {
  test("大文字にそろえ、形が違えば null", () => {
    expect(normalizeIssueRef(" api-8 ")).toBe("API-8");
    expect(normalizeIssueRef("API")).toBeNull();
    expect(normalizeIssueRef("")).toBeNull();
  });
});
