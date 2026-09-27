import { expect, test } from "./fixtures";

test("Document はタイトル、パス、本文を出す", async ({ page }) => {
  await page.goto("/documents/1");
  await expect(page.getByRole("heading", { level: 1, name: "検索 API の高速化 設計" })).toBeVisible();
  await expect(page.getByText("/Users/me/repo/api-server/docs/specs/2026-09-20-search-performance.md")).toBeVisible();
  await expect(page.getByText("/search の p95 を 200ms 以下にする。", { exact: false })).toBeVisible();
});

test("ファイルが見つからない Document はタイトルと「ファイルが見つかりません」を出す", async ({ page }) => {
  await page.goto("/documents/3");
  await expect(page.getByRole("heading", { level: 1, name: "nod 設計" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("ファイルが見つかりません");
});

test("存在しない Document は見つかりませんと出す", async ({ page }) => {
  await page.goto("/documents/999");
  await expect(page.getByRole("heading", { level: 1, name: "Document が見つかりません" })).toBeVisible();
});

test("Issue 詳細から Document に移り、再読み込みしても同じ画面が出る", async ({ page }) => {
  await page.goto("/issues/API-12");
  await page.getByRole("region", { name: "Documents", exact: true }).getByRole("link", { name: "検索 API の N+1 解消 実装計画" }).click();
  await expect(page).toHaveURL(/\/documents\/2$/);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "検索 API の N+1 解消 実装計画" })).toBeVisible();
});
