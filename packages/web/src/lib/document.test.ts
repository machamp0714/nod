import { describe, expect, test } from "bun:test";
import { displayPath, documentAssetSrc, normalizeIssueRef, parseDocumentId, stripLeadingTitle } from "./document";

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

  test("# の後の空白が複数やタブでも、タイトルと同じなら省く", () => {
    expect(stripLeadingTitle("#  題\n\n本文", "題")).toBe("本文");
    expect(stripLeadingTitle("#\t題\n\n本文", "題")).toBe("本文");
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

describe("documentAssetSrc", () => {
  test("相対パスだけを Document の assets の URL にする", () => {
    expect(documentAssetSrc(3, "images/a.png")).toBe("/api/documents/3/assets/images/a.png");
    expect(documentAssetSrc(3, "./images/画面 1.png")).toBe(`/api/documents/3/assets/images/${encodeURIComponent("画面 1.png")}`);
  });
  test("スキーム付き・/ 始まり・../ 始まりはそのまま", () => {
    for (const src of ["https://example.com/a.png", "http://x/a.png", "data:image/png;base64,AA", "/abs.png", "../assets/a.png"]) {
      expect(documentAssetSrc(3, src)).toBe(src);
    }
  });
  test("react-markdown が encode 済みで渡す src も、1回だけ encode した URL にする", () => {
    const jp = encodeURIComponent("画面-1.png");
    expect(documentAssetSrc(3, `images/${jp}`)).toBe(`/api/documents/3/assets/images/${jp}`);
    expect(documentAssetSrc(3, "images/画面-1.png")).toBe(`/api/documents/3/assets/images/${jp}`);
    expect(documentAssetSrc(3, "images/a%20b.png")).toBe("/api/documents/3/assets/images/a%20b.png");
  });
  test("不正な % の並びは生の文字として encode する", () => {
    expect(documentAssetSrc(3, "images/%E7.png")).toBe("/api/documents/3/assets/images/%25E7.png");
  });
  test("./ を除いた後に ../ が残るものはそのまま", () => {
    expect(documentAssetSrc(3, "./../x.png")).toBe("./../x.png");
  });
});
