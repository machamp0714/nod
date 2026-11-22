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
