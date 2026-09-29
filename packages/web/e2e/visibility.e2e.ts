import { expect, test } from "./fixtures";

test.use({ dataset: "issue-list" });

for (const path of ["/issues", "/views/1", "/projects/1"]) {
  test(`${path}: 完了と子Issueを独立して切り替え、履歴・再読込・Boardへ引き継ぐ`, async ({ page, nod }) => {
    await nod.me.updateIssue("API-12", { status: "done" });
    await page.goto(path);
    const completed = page.getByRole("link", { name: "検索 API の N+1 を解消", exact: true });
    const child = page.getByRole("link", { name: "workspace の取得をまとめる", exact: true });
    await expect(completed).toBeVisible();
    await expect(child).toBeVisible();
    await page.getByText("表示設定", { exact: true }).click();
    const showCompleted = page.getByRole("checkbox", { name: "完了済みIssueを表示", exact: true });
    const showChildren = page.getByRole("checkbox", { name: "子Issueを表示", exact: true });
    await showCompleted.uncheck();
    await expect(completed).toHaveCount(0);
    await expect(child).toBeVisible();
    await showChildren.uncheck();
    await expect(child).toHaveCount(0);
    await page.goBack();
    await expect(child).toBeVisible();
    await expect(completed).toHaveCount(0);
    await page.goForward();
    await expect(child).toHaveCount(0);
    await page.reload();
    await page.getByText("表示設定", { exact: true }).click();
    await expect(showCompleted).not.toBeChecked();
    await expect(showChildren).not.toBeChecked();
    await expect(completed).toHaveCount(0);
    await expect(child).toHaveCount(0);
    if (path === "/views/1") await expect(page.getByRole("button", { name: "変更を保存", exact: true })).toHaveCount(0);
    await page.getByLabel("グループ化", { exact: true }).selectOption("workspace");
    await expect(completed).toHaveCount(0);
    await expect(child).toHaveCount(0);
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    await expect(completed).toHaveCount(0);
    await expect(child).toHaveCount(0);
    await showChildren.check();
    await expect(child).toBeVisible();
    await expect(completed).toHaveCount(0);
    await showCompleted.check();
    await expect(completed).toBeVisible();
  });
}

test("不正URLは表示へ戻り、Status条件で除いたIssueを表示設定で復活させない", async ({ page, nod }) => {
  await nod.me.updateIssue("API-12", { status: "done" });
  await page.goto('/issues?showCompleted=bad&showChildren=%5Bfalse%5D&status=%5B%22done%22%5D');
  await page.getByText("表示設定", { exact: true }).click();
  const showCompleted = page.getByRole("checkbox", { name: "完了済みIssueを表示", exact: true });
  await expect(showCompleted).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "子Issueを表示", exact: true })).toBeChecked();
  await expect(page.getByRole("link", { name: "検索 API の N+1 を解消", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "workspace の取得をまとめる", exact: true })).toHaveCount(0);
  await showCompleted.uncheck();
  await expect(page.getByRole("cell", { name: "該当する Issue はありません" })).toBeVisible();
  await showCompleted.check();
  await expect(page.getByRole("link", { name: "検索 API の N+1 を解消", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "workspace の取得をまとめる", exact: true })).toHaveCount(0);
});
