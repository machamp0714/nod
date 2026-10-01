import { expect, test } from "bun:test";
import { defaultFeature, sanitizeFeature, worktreeName } from "./orca-feature";

test("feature 名の初期値は、タイトルの英数字の語を小文字にして - でつなぐ。英数字が無ければ空", () => {
  expect(defaultFeature("Orca で worktree を作成")).toBe("orca-worktree");
  expect(defaultFeature("検索 API の N+1 を解消")).toBe("api-n-1");
  expect(defaultFeature("fix: foo_bar（v2）")).toBe("fix-foo-bar-v2");
  expect(defaultFeature("ＡＰＩ を直す")).toBe("");
  expect(defaultFeature("検索を速くする")).toBe("");
  expect(defaultFeature("")).toBe("");
});

test("入力は英小文字・数字・- だけを残す", () => {
  expect(sanitizeFeature("search-n1")).toBe("search-n1");
  expect(sanitizeFeature("Search N+1_検索/x")).toBe("searchn1x");
  expect(sanitizeFeature(" ")).toBe("");
});

test("作成される名前は <Issue ID>+<feature>", () => {
  expect(worktreeName("API-12", "search-n1")).toBe("API-12+search-n1");
});
