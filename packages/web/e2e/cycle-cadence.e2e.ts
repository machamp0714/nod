import { expect, test } from "./fixtures";

test.use({ dataset: "sprint-history" });

test("旧一覧URLはSprintsへ移り、Cycle作成・周期・直接所属を出さない", async ({ page }) => {
  await page.goto("/cycles");
  await expect(page).toHaveURL(/\/sprints$/);
  await expect(page.getByRole("heading", { level: 1, name: "Sprints" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New cycle" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "周期の設定" })).toHaveCount(0);
  for (const name of ["過去", "現在だった期間", "未来", "空"]) await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
});

test("WorkspaceのCurrentだけが実行中Sprint詳細へ移り、分析をEscapeで閉じるとフォーカスが戻る", async ({ page }) => {
  await page.goto("/issues");
  await page.getByRole("button", { name: "元A を開閉" }).click();
  const current = page.locator("#workspace-AAA").getByRole("link", { name: /Current/ });
  await current.click();
  await expect(page.getByRole("heading", { level: 1, name: "実行 12" })).toBeVisible();
  await expect(current).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "メイン" }).getByRole("link", { name: "Sprints", exact: true })).not.toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "分析", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Sprint の分析" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "Sprint の分析" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "分析", exact: true })).toBeFocused();
});

test("旧URLの削除済みと対応なしを新Sprint番号へ読み替えず区別する", async ({ page }) => {
  await page.goto("/cycles/99");
  await expect(page.getByRole("heading", { name: "削除済みの旧Cycleです" })).toBeVisible();
  await page.goto("/cycles/12");
  await expect(page.getByRole("heading", { name: "旧Cycleが見つかりません" })).toBeVisible();
  await expect(page).toHaveURL(/\/cycles\/12$/);
});
