import { describe, expect, test } from "bun:test";
import { imageMarkdown, insertAt, replacePlaceholder, uploadPlaceholder } from "./document-paste";

describe("画像の貼り付けの仮の文字列", () => {
  test("毎回違う仮の文字列を作る", () => {
    const a = uploadPlaceholder();
    expect(a).toMatch(/^!\[アップロード中…\]\(uploading-[a-z0-9]{8}\)$/);
    expect(uploadPlaceholder()).not.toBe(a);
  });
  test("カーソル位置に入れ、前後に入力が続いても仮の文字列だけを置き換える", () => {
    const p = "![アップロード中…](uploading-abcd1234)";
    const text = insertAt("前後", 1, p);
    expect(text).toBe(`前${p}後`);
    const typed = `追加 ${text} さらに`;
    expect(replacePlaceholder(typed, p, "![](images/a.png)")).toBe("追加 前![](images/a.png)後 さらに");
    expect(replacePlaceholder(typed, p, "")).toBe("追加 前後 さらに");
  });
  test("置き換える文字列の $ をそのまま入れる", () => {
    const p = "![アップロード中…](uploading-abcd1234)";
    expect(replacePlaceholder(p, p, "![](images/$&.png)")).toBe("![](images/$&.png)");
  });
});

describe("画像の Markdown", () => {
  test("リンク先として壊れないパスはそのまま入れる", () => {
    expect(imageMarkdown("images/20261006-120000-ab12.png")).toBe("![](images/20261006-120000-ab12.png)");
    expect(imageMarkdown("images/画面-1.png")).toBe("![](images/画面-1.png)");
  });
  test("空白や括弧を含むパスは <> で囲む", () => {
    expect(imageMarkdown("images/screenshot-(1).png")).toBe("![](<images/screenshot-(1).png>)");
    expect(imageMarkdown("images/a b.png")).toBe("![](<images/a b.png>)");
  });
  test("<> を含むパスは <> で囲み、中の <> をエスケープする", () => {
    expect(imageMarkdown("images/a<b>.png")).toBe("![](<images/a\\<b\\>.png>)");
  });
});
