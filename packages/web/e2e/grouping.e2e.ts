import { expect, test } from "./fixtures";

test.use({ dataset: "issue-list" });

const region = (page: import("@playwright/test").Page, name: string) => page.getByRole("region", { name, exact: true });

for (const path of ["/issues", "/views/1", "/projects/1"]) {
  test(`${path}: プロパティでグループ化し、件数・値なしグループ・URL復元・並び順と共存する`, async ({ page }) => {
    await page.goto(`${path}?sort=title&direction=desc`);
    const grouping = page.getByLabel("グループ化", { exact: true });
    await grouping.selectOption("priority");
    await expect(page).toHaveURL(/groupBy=priority/);
    const high = region(page, "優先度 High");
    await expect(high).toBeVisible();
    await expect(high.getByRole("heading")).toContainText("High");
    // 見出しの件数は表示中の行数と一致する
    const rows = await high.locator("tbody tr").count();
    await expect(high.getByRole("heading").getByLabel(`${rows} 件`, { exact: true })).toBeVisible();
    // グループ内でもタイトル降順を保つ
    const titles = await high.locator("tbody tr td:nth-child(3) > a").allTextContents();
    expect(titles).toEqual([...titles].sort((a, b) => b.localeCompare(a, "ja", { numeric: true })));

    await grouping.selectOption("project");
    if (path === "/issues" || path === "/views/1") await expect(region(page, "Project Projectなし")).toBeVisible();
    await page.reload();
    await expect(grouping).toHaveValue("project");
    await expect(page).toHaveURL(/sort=title/);
    if (path === "/views/1") await expect(page.getByRole("button", { name: "変更を保存", exact: true })).toHaveCount(0);
  });
}

test("ラベルは複数のグループに重複して入り、検索で空になったグループは出さない", async ({ page, nod }) => {
  await nod.me.updateIssue("API-12", { addLabels: ["bug"] });
  await page.goto("/issues?groupBy=label");
  const link = (group: string) => region(page, `ラベル ${group}`).getByRole("link", { name: "検索 API の N+1 を解消", exact: true });
  await expect(link("bug")).toBeVisible();
  await expect(link("perf")).toBeVisible();
  await expect(region(page, "ラベル ラベルなし")).toBeVisible();
  await page.getByRole("textbox", { name: "検索", exact: true }).fill("N+1");
  await expect(region(page, "ラベル ラベルなし")).toHaveCount(0);
  await expect(link("bug")).toBeVisible();
  await page.getByRole("textbox", { name: "検索", exact: true }).fill("存在しないIssue");
  await expect(page.getByText("該当する Issue はありません", { exact: true })).toHaveCount(1);
});

test("BoardではStatusのグループ化を選べず、URLにあってもグループ化しない", async ({ page }) => {
  await page.goto("/issues?layout=board&groupBy=status");
  await expect(page.getByRole("option", { name: "Status", exact: true })).toHaveAttribute("disabled", "");
  await expect(page.getByLabel("グループ化", { exact: true })).toHaveValue("none");
  await expect(page.getByRole("region", { name: /^Status / })).toHaveCount(0);
  await page.getByRole("tab", { name: "List", exact: true }).click();
  await expect(region(page, "Status In Progress")).toBeVisible();
  await page.goto("/issues?layout=board&groupBy=assignee");
  await expect(region(page, "担当 claude-code")).toBeVisible();
  await expect(region(page, "担当 未割り当て")).toBeVisible();
});
