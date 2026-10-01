import { expect, test } from "./fixtures";
import { chooseDisplay, columnChip, displaySelect, openDisplay, searchBox, setColumn, setDirection, setLayout } from "./support/issue-list";

test.use({ dataset: "issue-list" });

for (const path of ["/issues", "/views/1", "/projects/1"]) {
  test(`${path}: 表示列を全て外しても識別・空表示・履歴復元を維持する`, async ({ page }) => {
    await page.goto(path);
    await chooseDisplay(page, "並び順", "タイトル");
    await setDirection(page, "desc");
    for (const name of ["優先度", "Status", "未決事項", "Workspace", "Project", "担当", "PR"]) await setColumn(page, name, false);
    await expect(page.getByRole("columnheader")).toHaveText(["ID", "Title"]);
    await page.goBack();
    await expect(page.getByRole("columnheader")).toHaveText(["ID", "Title", "PR"]);
    await page.goForward();
    await expect(page.getByRole("columnheader")).toHaveText(["ID", "Title"]);
    await page.reload();
    const popover = await openDisplay(page);
    await expect(await displaySelect(page, "並び順")).toHaveAttribute("data-value", "title");
    await expect(popover.getByRole("button", { name: "並び順の方向", exact: true })).toHaveAttribute("data-value", "desc");
    await expect(page.getByRole("columnheader")).toHaveText(["ID", "Title"]);
    await expect(page.getByRole("table").getByRole("link").first()).toBeVisible();
    if (path === "/views/1") await expect(page.getByRole("button", { name: "変更を保存", exact: true })).toHaveCount(0);
    await (await searchBox(page)).fill("存在しない表示設定確認");
    await expect(page.getByRole("cell", { name: "該当する Issue はありません" })).toHaveAttribute("colspan", "2");
    await (await columnChip(page, "Status")).focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("columnheader")).toHaveText(["Status", "ID", "Title"]);
  });

  test(`${path}: WorkspaceとBoard列内の並び順を保持する`, async ({ page, nod }) => {
    await nod.me.updateIssue("API-12", { title: "AAA 表示設定" });
    await nod.me.updateIssue("API-8", { title: "ZZZ 表示設定", projectRef: "1" });
    await page.goto(`${path}?sort=title&direction=desc&groupBy=workspace`);
    const group = page.getByRole("region", { name: "Workspace API", exact: true });
    await (await searchBox(page)).fill("表示設定");
    await expect(group.getByRole("table").locator("tbody tr").getByRole("link")).toHaveText(["ZZZ 表示設定", "AAA 表示設定"]);
    await setLayout(page, "Board");
    await expect(group.getByRole("region", { name: "In Progress", exact: true }).getByRole("link")).toHaveText(["ZZZ 表示設定", "AAA 表示設定"]);
    // Issue のある列は In Progress だけで、残りの5列は Hidden columns にまとまる
    await expect(group.getByRole("region")).toHaveCount(2);
    await expect(group.getByRole("region", { name: "Hidden columns", exact: true }).getByRole("listitem")).toHaveCount(5);
    await expect(await columnChip(page, "Status")).toBeDisabled();
  });
}

test("壊れたURLは既定値へ戻り狭い幅でも表示設定を操作できる", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/issues?sort=bad&direction=bad&columns=%22bad%22');
  await expect(page.getByRole("columnheader")).toHaveText(["優先度", "Status", "ID", "Title", "未決事項", "Project", "Workspace", "担当", "PR"]);
  const sort = await displaySelect(page, "並び順");
  await expect(sort).toHaveAttribute("data-value", "default");
  // キーボードだけで選ぶ：下キーで開くと選択中の「既定」にフォーカスがあり、下キーで「優先度」へ移って Enter で決める
  await sort.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "並び順", exact: true });
  await expect(menu.getByRole("menuitemradio", { name: "既定（Status・優先度・ID）", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemradio", { name: "優先度", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(sort).toBeFocused();
  await expect(sort).toHaveAttribute("data-value", "priority");
  await expect(page).toHaveURL(/[?&]sort=priority(?:&|$)/);
  // ポップオーバーを開いたままでも、ページと Main に横スクロールが出ない
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => { const main = document.querySelector("main") as HTMLElement; return main.scrollWidth <= main.clientWidth; })).toBe(true);
  // Escape はポップオーバーを閉じて、Display のボタンへフォーカスを戻す
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "表示設定" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "表示設定", exact: true })).toBeFocused();
  await page.reload();
  await expect(await displaySelect(page, "並び順")).toHaveAttribute("data-value", "priority");
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
    await expect(await displaySelect(page, "並び順")).toHaveAttribute("data-value", "priority");
    await expect(await columnChip(page, "Status")).toHaveAttribute("aria-pressed", "false");
  });
});
