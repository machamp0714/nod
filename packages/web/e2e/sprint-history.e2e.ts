import { expect, test } from "./fixtures";

test.use({ dataset: "sprint-history" });

test("旧URLは専用対応でimportedへ案内し、移行時の写しと不明を表示する", async ({ page }) => {
  await page.goto("/cycles/1");
  await expect(page).toHaveURL(/\/sprints\/[a-f0-9-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "過去" })).toBeVisible();
  await expect(page.getByText("移行履歴・読取専用", { exact: true })).toBeVisible();
  await expect(page.getByText("旧Cycle ID: 1", { exact: true })).toBeVisible();
  await expect(page.getByText("終了時点の成果は不明", { exact: true })).toBeVisible();
  await expect(page.locator('tr[data-issue-row="AAA-1"]')).toContainText("移行時は完了");
  await expect(page.locator('tr[data-issue-row="BBB-1"]')).toContainText("元B");
  await page.getByRole("button", { name: "分析", exact: true }).click();
  await expect(page.getByText("timezoneが未記録のため推移は不明", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cycle の操作" })).toHaveCount(0);
});

test("元Issueを変更・削除しても、移行時の表示と元Workspaceを保つ", async ({ page, nod }) => {
  await nod.me.updateIssue("AAA-1", { title: "現在の題名" });
  await nod.me.archiveIssue("AAA-1");
  await nod.me.deleteIssue("AAA-1");
  await page.goto("/cycles/1");
  const snapshot = page.locator('tr[data-issue-row="AAA-1"]');
  await expect(snapshot).toContainText("移行時は完了");
  await expect(snapshot).toContainText("元A");
  await expect(snapshot).not.toContainText("現在の題名");
});

test("旧検索URLの固定参照を専用対応で解決し、削除済み条件を外さない", async ({ page }) => {
  await page.goto("/issues?cycle=1");
  await expect(page).toHaveURL(/sprint=/);
  await expect(page).not.toHaveURL(/cycle=/);
  await expect(page.locator("tr[data-issue-row]")).toHaveCount(2);
  await page.goto("/issues?cycle=99");
  await expect(page.getByRole("alert")).toContainText("unresolved:cycle:99");
  await expect(page.locator("tr[data-issue-row]")).toHaveCount(0);
  await page.goto("/analytics?cycle=12");
  await expect(page.getByText("条件の Sprint（unresolved:cycle:12）が見つかりません").first()).toBeVisible();
  await expect(page.getByLabel("Sprint", { exact: true })).toHaveValue("unresolved:cycle:12");
});

test("旧currentとnoneは相対条件に移し、解決できない旧名は条件に残す", async ({ page }) => {
  await page.goto("/issues?cycle=current");
  await expect(page.getByRole("combobox", { name: "Sprint", exact: true })).toHaveValue("current");
  await expect(page.locator("tr[data-issue-row]")).toHaveCount(8);
  await page.goto("/issues?cycle=none");
  await expect(page.getByRole("combobox", { name: "Sprint", exact: true })).toHaveValue("none");
  await expect(page.getByText("候補のみ", { exact: true })).toBeVisible();
  await page.goto("/analytics?cycle=unknown-name");
  await expect(page.getByLabel("Sprint", { exact: true })).toHaveValue("unresolved:cycle:unknown-name");
  await expect(page.getByText("条件の Sprint（unresolved:cycle:unknown-name）が見つかりません").first()).toBeVisible();
});

test("元記録にないReady判定と質問数をゼロへ補わない", async ({ page }) => {
  await page.goto('/cycles/1?columns=["questions"]');
  await expect(page.getByRole("tab", { name: "Ready 不明", exact: true })).toBeVisible();
  await expect(page.locator('tr[data-issue-row="AAA-1"]')).toContainText("不明");
  await page.getByRole("tab", { name: "Ready 不明", exact: true }).click();
  await expect(page.getByText("移行時のReady判定は未記録です", { exact: true })).toBeVisible();
});
