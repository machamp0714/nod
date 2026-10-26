import { expect, test } from "./fixtures";

test.use({ dataset: "sprint-history" });

test("現在Viewは全状態の採択集合を表示し、移行履歴を現在Sprint列に混ぜない", async ({ page }) => {
  await page.goto("/views/1");
  await expect(page.locator("tr[data-issue-row]")).toHaveCount(8);
  const done = page.locator('tr[data-issue-row="AAA-1"]');
  await expect(done).toContainText("移行時は完了");
  await expect(done).toContainText("実行 12");
  await expect(done).not.toContainText("過去");
  for (const excluded of ["候補のみ", "終了Sprintのみ", "中止Sprintのみ"]) await expect(page.getByText(excluded, { exact: true })).toHaveCount(0);
  await expect(page.getByText("条件の Sprint（current）が見つかりません")).toHaveCount(0);
});

test("現在を選ぶと既定でSprintを識別でき、明示した列設定は保持する", async ({ page }) => {
  await page.goto("/issues?sprint=current");
  await expect(page.locator('tr[data-issue-row="AAA-1"]')).toContainText("実行 12");
  await page.goto("/issues?sprint=current&columns=[]");
  await expect(page.getByRole("columnheader", { name: "Sprint", exact: true })).toHaveCount(0);
  await page.goto('/issues?sprint=current&columns=["priority","status","workspace","project","assignee"]');
  await expect(page.getByRole("columnheader", { name: "Sprint", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("columnheader", { name: "Sprint", exact: true })).toHaveCount(0);
});

test("現在条件を名前・色・Sprint列と保存し、下書き取消後も相対条件を再表示する", async ({ page }) => {
  await page.goto('/issues?sprint=current&groupBy=status&columns=["status","workspace","sprint"]');
  await expect(page.locator("tr[data-issue-row]")).toHaveCount(8);
  await page.getByRole("button", { name: "View として保存", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "名前" }).fill("横断current");
  await dialog.getByRole("radio", { name: "緑", exact: true }).check();
  await expect(dialog).toContainText("現在");
  await expect(dialog).toContainText("Workspace");
  await expect(dialog).toContainText("Sprintが切り替わっても、同じViewで確認できます");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page).toHaveURL(/\/views\/2$/);
  await page.getByRole("combobox", { name: "Sprint", exact: true }).selectOption("none");
  await expect(page.getByText("変更あり", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Sprint", exact: true })).toHaveValue("current");
  await page.reload();
  await expect(page.locator("tr[data-issue-row]")).toHaveCount(8);
  const saved = await page.request.get("/api/views/2");
  const view = await saved.json();
  expect(view.filter).toEqual({ sprint: "current" });
  expect(view.color).toBe("#0E9F6E");
  expect(view.display.columns).toEqual(["status", "workspace", "sprint"]);
});
