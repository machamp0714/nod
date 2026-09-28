import { expect, test } from "./fixtures";

test.use({ dataset: "issue-list" });

const rows = (page: import("@playwright/test").Page) => page.getByRole("table").locator("tbody tr");

test("Projects は Active の Project を列つきで出す", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByRole("table").getByRole("columnheader")).toHaveText(["Name", "Workspace", "Progress", "LLM の状況", "Updated"]);
  await expect(rows(page)).toHaveCount(4);
  const search = page.getByRole("row", { name: /検索 API の高速化/ });
  await expect(search).toContainText("0/3");
  await expect(search).toContainText("入力待ち 1");
  await expect(search).toContainText("api-server");
  await expect(page.getByRole("row", { name: /nod CLI/ })).toHaveCount(0);
});

test("Completed のタブで完了した Project を出す", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("tablist", { name: "Project の絞り込み" }).getByRole("tab", { name: "Completed" }).click();
  await expect(page).toHaveURL(/tab=completed/);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("nod CLI");
});

test("不正な tab は Active に戻す", async ({ page }) => {
  await page.goto("/projects?tab=zzz");
  await expect(page.getByRole("tab", { name: "Active" })).toHaveAttribute("aria-selected", "true");
  await expect(rows(page)).toHaveCount(4);
});

test("Project 名を押すと Project 詳細に移る", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("link", { name: "決済まわり" }).click();
  await expect(page).toHaveURL(/\/projects\/2$/);
  await expect(page.getByRole("heading", { level: 1, name: "決済まわり" })).toBeVisible();
});

test("New project は準備中で押せない", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByRole("button", { name: "New project" })).toBeDisabled();
});
