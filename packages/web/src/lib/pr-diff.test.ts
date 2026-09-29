import { describe, expect, test } from "bun:test";
import { diffRows, fileStatusPill, githubFilesUrl, shortSha } from "./pr-diff";

describe("差分の行", () => {
  test("ハンクヘッダーから旧・新の行番号を数え、追加・削除・文脈に分ける", () => {
    const patch = "@@ -10,3 +10,4 @@ function f() {\n a\n-b\n+c\n+d\n e\n\\ No newline at end of file";
    expect(diffRows(patch)).toEqual([
      { kind: "hunk", text: "@@ -10,3 +10,4 @@ function f() {", oldNo: null, newNo: null },
      { kind: "context", text: "a", oldNo: 10, newNo: 10 },
      { kind: "del", text: "b", oldNo: 11, newNo: null },
      { kind: "add", text: "c", oldNo: null, newNo: 11 },
      { kind: "add", text: "d", oldNo: null, newNo: 12 },
      { kind: "context", text: "e", oldNo: 12, newNo: 13 },
      { kind: "note", text: "\\ No newline at end of file", oldNo: null, newNo: null },
    ]);
  });

  test("複数のハンク・行数を省いたヘッダー・空の文脈行", () => {
    const rows = diffRows("@@ -1 +1 @@\n-x\n+y\n@@ -20,2 +20,2 @@\n\n-z\n+w");
    expect(rows.map((r) => [r.kind, r.oldNo, r.newNo])).toEqual([
      ["hunk", null, null],
      ["del", 1, null],
      ["add", null, 1],
      ["hunk", null, null],
      ["context", 20, 20],
      ["del", 21, null],
      ["add", null, 21],
    ]);
  });

  test("HTML に見える行もそのままの文字列で返す（描画はテキストノードだけ）", () => {
    expect(diffRows("@@ -0,0 +1 @@\n+<img src=x onerror=alert(1)>")[1]!.text).toBe("<img src=x onerror=alert(1)>");
  });

  test("空の差分は行なし", () => {
    expect(diffRows("")).toEqual([]);
  });
});

describe("GitHub へのリンクと SHA", () => {
  test("GitHub の PR URL のときだけ Files タブの URL を返す", () => {
    expect(githubFilesUrl("https://github.com/o/r/pull/12")).toBe("https://github.com/o/r/pull/12/files");
    expect(githubFilesUrl("https://github.com/o/r/pull/12/")).toBe("https://github.com/o/r/pull/12/files");
    expect(githubFilesUrl("javascript:alert(1)//github.com/o/r/pull/1")).toBeNull();
    expect(githubFilesUrl("https://evil.example/o/r/pull/1")).toBeNull();
  });

  test("SHA は7文字に縮める", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });
});

describe("変更ファイルの状態ピル", () => {
  test("状態ごとの表示名と色。バイナリは状態より優先する", () => {
    expect(fileStatusPill({ status: "added", binary: false })).toEqual({ label: "追加", tone: "ready" });
    expect(fileStatusPill({ status: "modified", binary: false })).toEqual({ label: "変更", tone: "gate" });
    expect(fileStatusPill({ status: "deleted", binary: false })).toEqual({ label: "削除", tone: "fail" });
    expect(fileStatusPill({ status: "renamed", binary: false })).toEqual({ label: "名前変更", tone: "accent" });
    expect(fileStatusPill({ status: "added", binary: true })).toEqual({ label: "バイナリ", tone: "gate" });
  });
});
