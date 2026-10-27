import { expect, test } from "./fixtures";

test.use({ dataset: "sprint-history" });

test("有効な固定番号を未解決と表示せず、参照値を変えずに名前を表示する", async ({ page }) => {
  await page.goto("/issues?sprint=12");
  const sprint = page.getByRole("combobox", { name: "Sprint", exact: true });
  await expect(page.locator("tr[data-issue-row]")).toHaveCount(7);
  await expect(sprint).toHaveValue("12");
  await expect(sprint.locator('option:checked')).toHaveText("実行 12");
  await page.goto("/analytics?sprint=12");
  await expect(page.getByLabel("Sprint", { exact: true }).locator('option:checked')).toHaveText("実行 12");
  expect(String(JSON.parse(new URL(page.url()).searchParams.get("sprint")!))).toBe("12");
});
