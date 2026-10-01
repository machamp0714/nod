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
