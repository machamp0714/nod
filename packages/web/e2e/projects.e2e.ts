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

test("Project 詳細は API からその Project の Issue、件数、Documents を読む", async ({ page }) => {
  // ダミーデータにはない変更を API で加え、画面が API を読んでいることを確かめる
  const moved = await page.request.post("/api/issues/API-4/update", { data: { projectRef: "1" } });
  expect(moved.status()).toBe(200);
  await page.goto("/projects/1");
  await expect(page.getByRole("heading", { level: 1, name: "検索 API の高速化" })).toBeVisible();
  await expect(rows(page)).toHaveCount(4);
  for (const id of ["API-12", "API-13", "API-9", "API-4"]) {
    await expect(page.getByRole("cell", { name: id, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Ready 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Needs Clarification 1" })).toBeVisible();
  await expect(page.getByText("0/4 完了")).toBeVisible();
  await expect(page.getByRole("link", { name: "検索 API の高速化 設計" })).toHaveAttribute("href", "/documents/1");
  await expect(page.getByText("Filter", { exact: true })).toHaveCount(0);
});

test("Projects の All は完了した Project も出し、Workspace の列を Issue から集める", async ({ page }) => {
  const moved = await page.request.post("/api/issues/API-4/update", { data: { projectRef: "3" } });
  expect(moved.status()).toBe(200);
  await page.goto("/projects?tab=all");
  await expect(rows(page)).toHaveCount(5);
  const webUi = page.getByRole("row", { name: /nod Web UI/ });
  await expect(webUi).toContainText("api-server");
  await expect(webUi).toContainText("nod");
  await expect(page.getByRole("row", { name: /nod CLI/ })).toContainText("1/1");
});
