import { expect, test } from "./fixtures";
import { columnChip, searchBox, setColumn } from "./support/issue-list";

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
    await expect(await columnChip(page, "Workspace")).toHaveAttribute("aria-pressed", "true");
    await setColumn(page, "PR", false);
    // ポップオーバーの Escape はポップオーバーだけを閉じ、プレビューは次の Escape で閉じる
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "表示設定" })).toHaveCount(0);
    await expect(pane).toBeVisible();
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
  const search = await searchBox(page);
  await search.fill("決済");
  await search.press("Escape");
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

test("プレビューボタンは支援技術から見つけられ、閉じると元の行へフォーカスを戻す", async ({ page }) => {
  await page.goto("/issues");
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "検索 API の N+1 を解消", exact: true }) });
  const button = row.getByRole("button", { name: "API-12 をプレビュー", exact: true });
  // 行に触れる前から支援技術には見え、画面では隠れている
  await expect(button).toHaveCount(1);
  expect((await button.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
  await row.hover();
  await button.click();
  const pane = page.getByRole("complementary", { name: "API-12 のプレビュー", exact: true });
  await expect(pane).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
  await expect(button).toBeFocused();

  // 閉じるボタンで閉じても、Space で開いた行のリンクへ戻す
  const link = page.getByRole("link", { name: "決済 Webhook の再送処理", exact: true });
  await link.focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "プレビューを閉じる", exact: true }).click();
  await expect(link).toBeFocused();

  // URL から開いたプレビューは、閉じるとその行のリンクへ戻す
  // プレビューは一覧より先に出ることがある。行が描画される前に閉じると戻す先がないため、行を待ってから閉じる
  await page.goto("/issues?preview=API-12");
  await expect(pane).toBeVisible();
  await expect(row.getByRole("link", { name: "検索 API の N+1 を解消", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
  await expect(row.getByRole("link", { name: "検索 API の N+1 を解消", exact: true })).toBeFocused();
});

test("Viewの保存ダイアログでのEscapeはダイアログだけを閉じる", async ({ page }) => {
  await page.goto("/issues?preview=API-12");
  const pane = page.getByRole("complementary", { name: "API-12 のプレビュー", exact: true });
  await expect(pane).toBeVisible();
  await page.getByText("Filter", { exact: true }).click();
  await page.getByRole("group", { name: "Workspace" }).getByRole("checkbox", { name: "nod", exact: true }).check();
  await page.getByRole("button", { name: "View として保存" }).click();
  const dialog = page.getByRole("dialog", { name: "View として保存" });
  await dialog.getByRole("button", { name: "キャンセル" }).focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(pane).toBeVisible();
});

test("ラベルで重複して出る行は、最初の1行だけを現在のプレビューとして示す", async ({ page, nod }) => {
  await nod.me.updateIssue("API-12", { addLabels: ["bug"] });
  await page.goto("/issues?groupBy=label&preview=API-12");
  await expect(page.getByRole("complementary", { name: "API-12 のプレビュー", exact: true })).toBeVisible();
  const rows = page.getByRole("row").filter({ has: page.getByRole("link", { name: "検索 API の N+1 を解消", exact: true }) });
  await expect(rows).toHaveCount(2);
  await expect(page.locator("tr[aria-current=true]")).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("aria-current", "true");
});
