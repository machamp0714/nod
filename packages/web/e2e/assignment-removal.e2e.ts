import { expect, test } from "./fixtures";

test("My Issuesの旧URLはIssuesへ移り、委任中タブとMy Issuesのリンクを表示しない", async ({ page, nod }, testInfo) => {
  const { workspace } = await nod.me.initWorkspace({ path: nod.repo("handover"), key: "API" });
  await nod.me.createIssue({ workspaceId: workspace.id, title: "引き継ぐ作業" });
  await page.goto("/my-issues");
  await expect(page).toHaveURL(/\/issues$/);
  await expect(page.getByRole("row", { name: /引き継ぐ作業/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "My issues", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /委任中/ })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /^Ready / })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("issues.png") });
});

test("Issue詳細と一括編集に担当を指定する欄を表示しない", async ({ page, nod }, testInfo) => {
  const { workspace } = await nod.me.initWorkspace({ path: nod.repo("properties"), key: "API" });
  const issue = await nod.me.createIssue({ workspaceId: workspace.id, title: "担当なしで編集" });
  await page.goto(`/issues/${issue.id}`);
  const properties = page.getByRole("region", { name: "プロパティ" });
  await expect(properties.getByText("Assignee", { exact: true })).toHaveCount(0);
  await expect(properties.getByRole("button", { name: /担当/ })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("detail.png") });
  await page.goto("/issues");
  await page.getByRole("row", { name: /担当なしで編集/ }).getByRole("checkbox").check();
  const toolbar = page.getByRole("toolbar", { name: "一括操作" });
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "担当", exact: true })).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: "優先度", exact: true })).toBeVisible();
});
