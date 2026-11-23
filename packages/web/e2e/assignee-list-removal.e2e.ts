import { expect, test } from "./fixtures";
import { chooseDisplay, closeDisplay, columnChip, displaySelect, setLayout } from "./support/issue-list";

test.use({ dataset: "issue-list" });

test("Issue 一覧のフィルタ・表示列・グループ・ボード・プレビューに担当がない", async ({ page }) => {
  await page.goto("/issues");
  const table = page.getByRole("table").first();
  await expect(table.getByRole("columnheader", { name: "Workspace", exact: true })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "担当", exact: true })).toHaveCount(0);

  const filter = page.getByRole("button", { name: "絞り込み条件を開く", exact: true });
  await filter.click();
  await expect(page.getByRole("group", { name: "Status", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "担当", exact: true })).toHaveCount(0);
  await filter.click();

  await expect(await columnChip(page, "Workspace")).toBeVisible();
  await expect(await columnChip(page, "担当")).toHaveCount(0);
  await chooseDisplay(page, "グループ化", "Status");
  for (const menu of ["グループ化", "サブグループ"] as const) {
    await (await displaySelect(page, menu)).click();
    const options = page.getByRole("menu", { name: menu, exact: true });
    await expect(options.getByRole("menuitemradio", { name: "Project", exact: true })).toBeVisible();
    await expect(options.getByRole("menuitemradio", { name: "担当", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
  }

  await setLayout(page, "Board");
  await closeDisplay(page);
  await expect(page.locator("main article").first()).toBeVisible();
  await expect(page.locator("main article [title='未割り当て'], main article [title='codex'], main article [title='claude-code']")).toHaveCount(0);

  await page.goto("/issues?layout=list&preview=API-12");
  const preview = page.getByRole("complementary", { name: "API-12 のプレビュー" });
  await expect(preview.getByText("優先度", { exact: true })).toBeVisible();
  await expect(preview.getByText("担当", { exact: true })).toHaveCount(0);
});

test.describe("廃止した URL の条件", () => {
  test.use({ allowedConsoleErrors: [/SearchParamError|担当は廃止されました/] });

  for (const query of [
    "assignee=",
    `columns=${encodeURIComponent(JSON.stringify(["status", "assignee"]))}`,
    "groupBy=assignee",
    "groupBy=status&subGroupBy=assignee",
  ]) {
    test(`一覧の URL で ${query} を明示的に拒否する`, async ({ page }) => {
      await page.goto(`/issues?${query}`);
      await expect(page.getByText(/担当は廃止されました/)).toBeVisible();
      await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(0);
    });
  }
});
