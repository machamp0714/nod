import { expect, test } from "./fixtures";

test.use({ dataset: "issue-list" });

for (const path of ["/issues", "/views/1", "/projects/1"]) {
  test(`${path}: 一覧から離れずにIssueをプレビューし、URLで復元してEscで閉じる`, async ({ page }) => {
    await page.goto(`${path}?groupBy=workspace&sort=title`);
    const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "検索 API の N+1 を解消", exact: true }) });
    await row.hover();
    await row.getByRole("button", { name: "API-12 をプレビュー", exact: true }).click();
    const pane = page.getByRole("complementary", { name: "API-12 のプレビュー", exact: true });
    await expect(pane.getByRole("heading", { level: 2, name: "検索 API の N+1 を解消" })).toBeVisible();
    await expect(pane).toContainText("100 件の検索でクエリが 3 回以下");
    await expect(pane).toContainText("perf");
    await expect(pane).toContainText("1 / 2 決定");
    await expect(pane.getByRole("link", { name: "Issue を開く" })).toHaveAttribute("href", "/issues/API-12");
    await expect(page).toHaveURL(/preview=API-12/);
    await expect(page).toHaveURL(new RegExp(path.replace("/", "\\/")));
    await expect(row).toHaveAttribute("aria-current", "true");
    // プレビュー中は Workspace 列を隠し、他の表示設定は保つ
    await expect(page.getByRole("columnheader", { name: "Workspace", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Workspace API", exact: true })).toBeVisible();
    await page.reload();
    await expect(pane.getByRole("heading", { level: 2, name: "検索 API の N+1 を解消" })).toBeVisible();
    // プレビューで隠した Workspace 列は表示設定を変えない
    await page.getByText("表示設定", { exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Workspace", exact: true })).toBeChecked();
    await page.getByRole("checkbox", { name: "PR", exact: true }).uncheck();
    await page.getByText("表示設定", { exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(pane).toHaveCount(0);
    await expect(page).not.toHaveURL(/preview=/);
    await expect(page).toHaveURL(/groupBy=workspace/);
    await expect(page.getByRole("columnheader", { name: "Workspace", exact: true }).first()).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "PR", exact: true })).toHaveCount(0);
  });
}

test("行のリンクにフォーカスしてSpaceでプレビューし、閉じるボタンで閉じる", async ({ page }) => {
  await page.goto("/issues");
  await page.getByRole("link", { name: "決済 Webhook の再送処理", exact: true }).focus();
  await page.keyboard.press("Space");
  const pane = page.getByRole("complementary", { name: "API-8 のプレビュー", exact: true });
  await expect(pane.getByRole("heading", { level: 2, name: "決済 Webhook の再送処理" })).toBeVisible();
  await expect(pane).toContainText("codex");
  await expect(page).toHaveURL(/\/issues\?preview=API-8$/);
  // 検索欄での Escape はプレビューを閉じない
  await page.getByRole("textbox", { name: "検索", exact: true }).fill("決済");
  await page.getByRole("textbox", { name: "検索", exact: true }).press("Escape");
  await expect(pane).toBeVisible();
  await pane.getByRole("button", { name: "プレビューを閉じる", exact: true }).click();
  await expect(pane).toHaveCount(0);
});

test.describe("プレビューの取得失敗", () => {
  test.use({ allowedConsoleErrors: [/Failed to load resource.*status of 404/] });
  test("存在しないIssueは一覧を保ったまま見つからないと表示する", async ({ page }) => {
    await page.goto("/issues?preview=API-999");
    const pane = page.getByRole("complementary", { name: "API-999 のプレビュー", exact: true });
    await expect(pane.getByRole("alert")).toHaveText("Issue API-999 が見つかりません");
    await expect(page.getByRole("link", { name: "検索 API の N+1 を解消", exact: true })).toBeVisible();
  });
});
