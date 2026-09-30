import { expect, test } from "./fixtures";
import { chooseDisplay, displaySwitch, openDisplay, setLayout } from "./support/issue-list";

test.use({ dataset: "issue-list" });

for (const path of ["/issues", "/views/1", "/projects/1"]) {
  test(`${path}: 完了と子Issueを独立して切り替え、履歴・再読込・Boardへ引き継ぐ`, async ({ page, nod }) => {
    await nod.me.updateIssue("API-12", { status: "done" });
    await page.goto(path);
    const completed = page.getByRole("link", { name: "検索 API の N+1 を解消", exact: true });
    const child = page.getByRole("link", { name: "workspace の取得をまとめる", exact: true });
    await expect(completed).toBeVisible();
    await expect(child).toBeVisible();
    const showCompleted = await displaySwitch(page, "完了済み Issue を表示");
    const showChildren = await displaySwitch(page, "子 Issue を表示");
    await showCompleted.click();
    await expect(completed).toHaveCount(0);
    await expect(child).toBeVisible();
    await showChildren.click();
    await expect(child).toHaveCount(0);
    await page.goBack();
    await expect(child).toBeVisible();
    await expect(completed).toHaveCount(0);
    await page.goForward();
    await expect(child).toHaveCount(0);
    await page.reload();
    await openDisplay(page);
    await expect(showCompleted).toHaveAttribute("aria-checked", "false");
    await expect(showChildren).toHaveAttribute("aria-checked", "false");
    await expect(completed).toHaveCount(0);
    await expect(child).toHaveCount(0);
    if (path === "/views/1") await expect(page.getByRole("button", { name: "変更を保存", exact: true })).toHaveCount(0);
    await chooseDisplay(page, "グループ化", "Workspace");
    await expect(completed).toHaveCount(0);
    await expect(child).toHaveCount(0);
    await setLayout(page, "Board");
    await expect(completed).toHaveCount(0);
    await expect(child).toHaveCount(0);
    await showChildren.click();
    await expect(showChildren).toHaveAttribute("aria-checked", "true");
    await expect(child).toBeVisible();
    await expect(completed).toHaveCount(0);
    await showCompleted.click();
    await expect(showCompleted).toHaveAttribute("aria-checked", "true");
    await expect(completed).toBeVisible();
  });
}

test("不正URLは表示へ戻り、Status条件で除いたIssueを表示設定で復活させない", async ({ page, nod }) => {
  await nod.me.updateIssue("API-12", { status: "done" });
  await page.goto('/issues?showCompleted=bad&showChildren=%5Bfalse%5D&status=%5B%22done%22%5D');
  const showCompleted = await displaySwitch(page, "完了済み Issue を表示");
  await expect(showCompleted).toHaveAttribute("aria-checked", "true");
  await expect(await displaySwitch(page, "子 Issue を表示")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("link", { name: "検索 API の N+1 を解消", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "workspace の取得をまとめる", exact: true })).toHaveCount(0);
  await showCompleted.click();
  await expect(showCompleted).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("cell", { name: "該当する Issue はありません" })).toBeVisible();
  await showCompleted.click();
  await expect(page.getByRole("link", { name: "検索 API の N+1 を解消", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "workspace の取得をまとめる", exact: true })).toHaveCount(0);
});
