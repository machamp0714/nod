import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { DOC, ISSUE, MISSING_FILE, SPEC_FILE } from "./issue-detail-data";

test.use({ dataset: "issue-detail" });

test("Document はタイトル、パス、Markdown の本文を出す", async ({ page }) => {
  await page.goto(`/documents/${DOC.spec}`);
  await expect(page.getByRole("heading", { level: 1, name: "検索 API の高速化 設計" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "検索 API の高速化 設計" })).toHaveCount(1);
  await expect(page.getByText(SPEC_FILE, { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "方針" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "複合インデックスを足す" })).toBeVisible();
  await expect(page.getByText("/search の p95 を 200ms 以下にする。")).toBeVisible();
  // Document は Markdown ファイルそのものなので、折り返しの改行は1段落につなぐ（説明と違い <br> にしない。#176）
  const wrapped = page.locator("p").filter({ hasText: "計測は本番相当のデータで行う。" });
  await expect(wrapped).toContainText("/search の p95 を 200ms 以下にする。");
  await expect(wrapped.locator("br")).toHaveCount(0);
});

// 完了条件：ファイルがなければタイトルと「ファイルが見つかりません」
test("ファイルが見つからない Document はタイトルと「ファイルが見つかりません」を出す", async ({ page }) => {
  await page.goto(`/documents/${DOC.missing}`);
  await expect(page.getByRole("heading", { level: 1, name: "nod 設計" })).toBeVisible();
  await expect(page.getByText(MISSING_FILE, { exact: false })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("ファイルが見つかりません");
});

test("Issue 詳細から Document に移り、再読み込みしても同じ画面が出る", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.main}`);
  await region(page, "Documents").getByRole("link", { name: "nod 設計" }).click();
  await expect(page).toHaveURL(new RegExp(`/documents/${DOC.missing}$`));
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "nod 設計" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("ファイルが見つかりません");

  await page.goBack();
  await region(page, "Documents").getByRole("link", { name: "検索 API の N+1 解消 実装計画" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "検索 API の N+1 解消 実装計画" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 4, name: "Task 2: インデックス設計" })).toBeVisible();
});

test("数字でない Document の ID は、API を呼ばずに見つかりませんと出す", async ({ page }) => {
  await page.goto("/documents/abc");
  await expect(page.getByRole("heading", { level: 1, name: "Document が見つかりません" })).toBeVisible();
});

test.describe("存在しない Document", () => {
  test.use({ allowedConsoleErrors: [/status of 404/] });

  test("再試行を待たずに見つかりませんと出す", async ({ page }) => {
    await page.goto("/documents/999");
    await expect(page.getByRole("heading", { level: 1, name: "Document が見つかりません" })).toBeVisible({ timeout: 2_000 });
  });
});

const specPath = (nod: { repo(name: string): string }) => join(nod.repo("api-server"), SPEC_FILE);

// NOD-3：本文をクリックして生の Markdown を直接編集する
test.describe("本文の直接編集", () => {

  test("本文をクリックすると生の Markdown を編集でき、blur で保存されファイルとタイトルに残る", async ({ page, nod }) => {
    await page.goto(`/documents/${DOC.spec}`);
    await page.getByText("/search の p95 を 200ms 以下にする。").first().click();
    const editor = page.getByRole("textbox", { name: "本文" });
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue(/^# 検索 API の高速化 設計/);
    await editor.fill("# 検索の設計 改\n\n書き換えた本文\n");
    await editor.blur();
    await expect(page.getByText("書き換えた本文")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "検索の設計 改" })).toBeVisible();
    expect(readFileSync(specPath(nod), "utf8")).toBe("# 検索の設計 改\n\n書き換えた本文\n");
    await page.reload();
    await expect(page.getByText("書き換えた本文")).toBeVisible();
  });

  test("Cmd+S で保存し、Esc では保存せずに戻る", async ({ page, nod }) => {
    await page.goto(`/documents/${DOC.spec}`);
    await page.getByText("/search の p95 を 200ms 以下にする。").first().click();
    const editor = page.getByRole("textbox", { name: "本文" });
    await editor.fill("# 検索 API の高速化 設計\n\n保存する\n");
    await editor.press("ControlOrMeta+s");
    await expect(page.getByText("保存する")).toBeVisible();
    await page.getByText("保存する").click();
    await editor.fill("# 検索 API の高速化 設計\n\n捨てる\n");
    await editor.press("Escape");
    await expect(page.getByText("保存する")).toBeVisible();
    expect(readFileSync(specPath(nod), "utf8")).toBe("# 検索 API の高速化 設計\n\n保存する\n");
  });

  test("日本語の変換中の Esc では下書きを捨てない", async ({ page }) => {
    await page.goto(`/documents/${DOC.spec}`);
    await page.getByText("/search の p95 を 200ms 以下にする。").first().click();
    const editor = page.getByRole("textbox", { name: "本文" });
    await editor.fill("# 検索 API の高速化 設計\n\n変換中の下書き\n");
    // 変換の確定・取り消しの Esc は isComposing が立った keydown として届く
    await editor.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue(/変換中の下書き/);
  });

  // SPEC_BODY には本文中のリンクがないため、リンクのクリックで編集に入らないことは単体テスト（document-edit.test.ts）に任せる
  test("ファイルがない Document は編集できない", async ({ page }) => {
    await page.goto(`/documents/${DOC.missing}`);
    await page.getByRole("status").click();
    await expect(page.getByRole("textbox", { name: "本文" })).toHaveCount(0);
  });
});

test.describe("本文の直接編集の競合", () => {
  test.use({ allowedConsoleErrors: [/status of 409/] });

  test("ほかで書き換えられていたら 409 を出して下書きを残し、読み直すと最新の mtime で保存できる", async ({ page, nod }) => {
    await page.goto(`/documents/${DOC.spec}`);
    await page.getByText("/search の p95 を 200ms 以下にする。").first().click();
    const editor = page.getByRole("textbox", { name: "本文" });
    await editor.fill("# 検索 API の高速化 設計\n\n私の下書き\n");
    writeFileSync(specPath(nod), "# 検索 API の高速化 設計\n\nほかの変更\n");
    utimesSync(specPath(nod), new Date(), new Date(Date.now() + 5_000));
    await editor.press("ControlOrMeta+s");
    await expect(page.getByRole("alert")).toContainText("ほかで変更されています");
    await expect(editor).toHaveValue(/私の下書き/);
    await page.getByRole("button", { name: "読み直す" }).click();
    await expect(editor).toHaveValue(/ほかの変更/);
    await expect(page.getByRole("alert")).toHaveCount(0);
    // 読み直した後の mtime で送るので、今度は 409 にならずに保存できる
    await editor.fill("# 検索 API の高速化 設計\n\n読み直した後の変更\n");
    await editor.press("ControlOrMeta+s");
    await expect(page.getByText("読み直した後の変更")).toBeVisible();
    await expect(editor).toHaveCount(0);
    expect(readFileSync(specPath(nod), "utf8")).toBe("# 検索 API の高速化 設計\n\n読み直した後の変更\n");
  });
});
