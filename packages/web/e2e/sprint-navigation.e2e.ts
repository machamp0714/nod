import { expect, test } from "./fixtures";

test.use({ dataset: "issue-list" });

test("Workspaceの開閉は遷移せず、現在なしと配下の導線を表示する", async ({ page }) => {
  await page.goto("/inbox");
  const nav = page.getByRole("navigation", { name: "メイン" });
  await expect(nav.getByRole("link", { name: "Sprints", exact: true })).toBeVisible();
  const toggle = nav.getByRole("button", { name: "nod を開閉" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page).toHaveURL(/\/inbox$/);
  const children = page.locator("#workspace-NOD");
  await expect(children.getByText("なし", { exact: true })).toBeVisible();
  await expect(children.getByRole("link", { name: "Issues", exact: true })).toBeVisible();
  await expect(children.getByRole("link", { name: "Projects", exact: true })).toBeVisible();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(children).toHaveCount(0);
  await expect(page).toHaveURL(/\/inbox$/);
});

test("Workspace配下のIssuesとProjectsはそのWorkspaceの範囲で開く", async ({ page }) => {
  await page.goto("/inbox");
  await page.getByRole("button", { name: "nod を開閉" }).click();
  const children = page.locator("#workspace-NOD");
  await children.getByRole("link", { name: "Issues", exact: true }).click();
  await expect(page.locator("tr[data-issue-row]").first()).toBeVisible();
  expect(await page.locator("tr[data-issue-row]").evaluateAll((rows) => rows.every((row) => row.getAttribute("data-issue-row")?.startsWith("NOD-")))).toBe(true);
  await children.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("link", { name: "nod Web UI", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "検索 API の高速化", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page).toHaveURL(/workspace=NOD/);
  await expect(page.getByRole("link", { name: "検索 API の高速化", exact: true })).toHaveCount(0);
});
