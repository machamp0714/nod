import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";

test("レビュー導線と状態を表示せず、作業中の Issue を直接完了にできる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("直接完了する Issue");
  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByRole("heading", { level: 1, name: issue.title })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Reviews/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Status", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name: "In Review", exact: true })).toHaveCount(0);
  await page.getByRole("menuitemradio", { name: "Done", exact: true }).click();
  await expect(page.getByRole("group", { name: "状態" })).toContainText("Done");
  expect((await nod.me.getIssue(issue.id)).status).toBe("done");
});

test("Workspace 設定にレビュー必須と PR・コミットのレビュー連動を表示しない", async ({ page, nod }) => {
  await seedApiWorkspace(nod);
  await page.goto("/workspaces/API/settings");
  await expect(page.getByRole("heading", { name: "ステータス遷移", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /の前に.*必須にする/ })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "PR 連動", exact: true })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "コミット連動", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "in_review の表示名" })).toHaveCount(0);
  await page.goto("/reviews");
  await expect(page.getByRole("heading", { name: "ページが見つかりません", exact: true })).toBeVisible();
});
