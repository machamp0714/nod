import { expect, test } from "./fixtures";

test.use({ dataset: "issue-list" });

for (const path of ["/issues", "/views/1", "/projects/1"]) {
  test(`${path}: 表示列を全て外しても識別・空表示・履歴復元を維持する`, async ({ page }) => {
    await page.goto(path);
    await page.getByText("表示設定", { exact: true }).click();
    await page.getByLabel("並び順", { exact: true }).selectOption("title");
    await page.getByLabel("並び順の方向", { exact: true }).selectOption("desc");
    for (const name of ["Status", "未決事項", "Workspace", "PR"]) await page.getByRole("checkbox", { name, exact: true }).uncheck();
    await expect(page.getByRole("columnheader")).toHaveText(["ID", "Title"]);
    await page.goBack();
    await expect(page.getByRole("columnheader")).toHaveText(["ID", "Title", "PR"]);
    await page.goForward();
    await expect(page.getByRole("columnheader")).toHaveText(["ID", "Title"]);
    await page.reload();
    await page.getByText("表示設定", { exact: true }).click();
    await expect(page.getByLabel("並び順", { exact: true })).toHaveValue("title");
    await expect(page.getByLabel("並び順の方向", { exact: true })).toHaveValue("desc");
    await expect(page.getByRole("columnheader")).toHaveText(["ID", "Title"]);
    await expect(page.getByRole("table").getByRole("link").first()).toBeVisible();
    if (path === "/views/1") await expect(page.getByRole("button", { name: "変更を保存", exact: true })).toHaveCount(0);
    await page.getByRole("textbox", { name: "検索", exact: true }).fill("存在しない表示設定確認");
    await expect(page.getByRole("cell", { name: "該当する Issue はありません" })).toHaveAttribute("colspan", "2");
    await page.getByRole("checkbox", { name: "Status", exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("columnheader")).toHaveText(["Status", "ID", "Title"]);
  });

  test(`${path}: WorkspaceとBoard列内の並び順を保持する`, async ({ page, nod }) => {
    await nod.me.updateIssue("API-12", { title: "AAA 表示設定" });
    await nod.me.updateIssue("API-8", { title: "ZZZ 表示設定", projectRef: "1" });
    await page.goto(`${path}?sort=title&direction=desc&groupBy=workspace`);
    const group = page.getByRole("region", { name: "Workspace API", exact: true });
    await page.getByRole("textbox", { name: "検索", exact: true }).fill("表示設定");
    await expect(group.getByRole("table").locator("tbody tr").getByRole("link")).toHaveText(["ZZZ 表示設定", "AAA 表示設定"]);
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    await expect(group.getByRole("region", { name: "In Progress", exact: true }).getByRole("link")).toHaveText(["ZZZ 表示設定", "AAA 表示設定"]);
    await expect(group.getByRole("region")).toHaveCount(6);
    await page.getByText("表示設定", { exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Status", exact: true })).toBeDisabled();
  });
}

test("壊れたURLは既定値へ戻り狭い幅でも表示設定を操作できる", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/issues?sort=bad&direction=bad&columns=%22bad%22');
  await expect(page.getByRole("columnheader")).toHaveText(["Status", "ID", "Title", "未決事項", "Workspace", "PR"]);
  await page.getByText("表示設定", { exact: true }).click();
  const sort = page.getByLabel("並び順", { exact: true });
  await expect(sort).toHaveValue("default");
  await sort.focus();
  await expect(sort).toBeFocused();
  // macOS の ArrowDown はまずメニューを開くため、開く操作と選択移動を分ける。
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(sort).toHaveValue("priority");
  await expect(page).toHaveURL(/[?&]sort=priority(?:&|$)/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.reload();
  await page.getByText("表示設定", { exact: true }).click();
  await expect(sort).toHaveValue("priority");
});

test.describe("表示設定の取得失敗", () => {
  test.use({ allowedConsoleErrors: [/Failed to load resource.*status of 500/] });
  test("取得失敗と読み込み中も表示設定を保持する", async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let hits = 0;
    await page.route(/\/api\/issues(?:\?|$)/, async (route) => {
      await gate;
      hits++;
      await route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "表示設定の取得失敗テスト" } } });
    });
    await page.goto("/issues?sort=priority&columns=[]");
    await expect(page.getByRole("status")).toContainText("読み込み中");
    release();
    // 5xx は shouldRetry で3回再試行され、間隔が 1s・2s・4s と伸びるため、表示まで約7秒かかる
    await expect(page.getByRole("alert")).toContainText("表示設定の取得失敗テスト", { timeout: 15_000 });
    expect(hits).toBeGreaterThanOrEqual(4);
    await page.getByText("表示設定", { exact: true }).click();
    await expect(page.getByLabel("並び順", { exact: true })).toHaveValue("priority");
    await expect(page.getByRole("checkbox", { name: "Status", exact: true })).not.toBeChecked();
  });
});
