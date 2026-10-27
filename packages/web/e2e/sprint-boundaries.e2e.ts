import { expect, test } from "./fixtures";

test.describe("現在なし", () => {
  test.use({ dataset: "issue-list" });
  test("現在なしは正常な空表示にし、相対条件を保持する", async ({ page }) => {
    await page.goto("/issues?sprint=current");
    await expect(page.getByText("現在のSprintはありません", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Sprint", exact: true })).toHaveValue("current");
  });
});

test.describe("失敗と再試行", () => {
  test.use({ dataset: "sprint-history", allowedConsoleErrors: [/status of 400/] });

  test("current API失敗をなしと区別し、条件を保持したまま再試行する", async ({ page }) => {
    let retryClicked = false;
    await page.exposeFunction("currentRetryClicked", () => { retryClicked = true; });
    // SSEなどの自動取得では復旧させず、利用者の再試行クリック後の要求だけを通す。
    await page.route("**/api/sprints/current", (route) => retryClicked ? route.continue() : route.fulfill({ status: 400, json: { error: { code: "INVALID_ARGS", message: "現在の取得失敗" } } }));
    await page.goto("/views/1");
    await expect(page.getByRole("alert")).toContainText("現在の取得失敗");
    await expect(page.getByText("現在のSprintはありません", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "元A を開閉" }).click();
    await expect(page.locator("#workspace-AAA")).toContainText("取得失敗");
    await expect(page.getByRole("combobox", { name: "Sprint", exact: true })).toHaveValue("current");
    await expect(page.locator("tr[data-issue-row]")).toHaveCount(0);
    const retry = page.getByRole("button", { name: "再試行", exact: true });
    await retry.evaluate((button) => {
      // Reactの委譲ハンドラが再取得を始める前に、実際のクリックをNode側へ通知する。
      button.addEventListener("click", () => {
        void (window as unknown as { currentRetryClicked: () => Promise<void> }).currentRetryClicked();
      }, { once: true });
    });
    const recovered = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/sprints/current" && response.status() === 200);
    await retry.click();
    await recovered;
    expect(retryClicked).toBe(true);
    await expect(page.locator("tr[data-issue-row]")).toHaveCount(8);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Sprint", exact: true })).toHaveValue("current");
    await expect(page).toHaveURL(/\/views\/1$/);
  });

  test("旧参照の取得失敗では旧条件を残し、再試行後だけ移行先へ置き換える", async ({ page }) => {
    let retryClicked = false;
    await page.exposeFunction("legacyRetryClicked", () => { retryClicked = true; });
    // 旧参照も、クリック前の自動取得では移行先へ解決させない。
    await page.route("**/api/cycles/1", (route) => retryClicked ? route.continue() : route.fulfill({ status: 400, json: { error: { code: "INVALID_ARGS", message: "旧対応の取得失敗" } } }));
    await page.goto("/issues?cycle=1");
    await expect(page.getByRole("alert")).toContainText("旧対応の取得失敗");
    await expect(page).toHaveURL(/cycle=1/);
    await expect(page.locator("tr[data-issue-row]")).toHaveCount(0);
    const retry = page.getByRole("button", { name: "再試行", exact: true });
    await retry.evaluate((button) => {
      button.addEventListener("click", () => {
        void (window as unknown as { legacyRetryClicked: () => Promise<void> }).legacyRetryClicked();
      }, { once: true });
    });
    const recovered = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/cycles/1" && response.status() === 200);
    await retry.click();
    await recovered;
    expect(retryClicked).toBe(true);
    await expect(page).toHaveURL(/sprint=/);
    await expect(page.locator("tr[data-issue-row]")).toHaveCount(2);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("新規保存失敗は名前・色・currentを保持し、再試行して保存できる", async ({ page }) => {
    await page.route("**/api/views", (route) => route.request().method() === "POST" ? route.fulfill({ status: 400, json: { error: { code: "INVALID_ARGS", message: "保存fixture失敗" } } }) : route.continue());
    await page.goto("/issues?sprint=current");
    await page.getByRole("button", { name: "View として保存", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "名前" }).fill("失敗後も保持");
    await dialog.getByRole("radio", { name: "緑", exact: true }).check();
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("保存fixture失敗");
    await expect(dialog.getByRole("textbox", { name: "名前" })).toHaveValue("失敗後も保持");
    await expect(dialog.getByRole("radio", { name: "緑", exact: true })).toBeChecked();
    await expect(dialog).toContainText("現在");
    await page.unroute("**/api/views");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page).toHaveURL(/\/views\/2$/);
    await expect(page.locator("tr[data-issue-row]")).toHaveCount(8);
  });

  test("更新失敗で下書きを保持し、取消と再更新ができる", async ({ page }) => {
    await page.route("**/api/views/1", (route) => route.request().method() === "PUT" ? route.fulfill({ status: 400, json: { error: { code: "INVALID_ARGS", message: "更新fixture失敗" } } }) : route.continue());
    await page.goto("/views/1");
    await page.getByRole("combobox", { name: "Sprint", exact: true }).selectOption("none");
    await page.getByRole("button", { name: "変更を保存", exact: true }).click();
    await expect(page.getByText("保存できませんでした", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Sprint", exact: true })).toHaveValue("none");
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Sprint", exact: true })).toHaveValue("current");
    await page.unroute("**/api/views/1");
    await page.getByRole("combobox", { name: "Sprint", exact: true }).selectOption("none");
    await page.getByRole("button", { name: "変更を保存", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Sprint", exact: true })).toHaveValue("none");
  });
});
