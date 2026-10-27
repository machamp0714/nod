import { expect, test, waitForServerEvents } from "./fixtures";

test.use({ dataset: "sprint-history" });

test("移行履歴のBoardは通常の濃さと非busyで読め、ドラッグしても変更しない", async ({ page }) => {
  await page.goto("/sprints/1?layout=board&groupBy=none");
  const cards = page.getByRole("article");
  await expect(cards).toHaveCount(2);
  for (const card of await cards.all()) {
    await expect(card).not.toHaveAttribute("aria-busy", "true");
    await expect(card).not.toHaveAttribute("data-saving");
    await expect(card).toHaveCSS("opacity", "1");
    await expect(card).toHaveAttribute("draggable", "false");
  }
  await page.screenshot({ path: test.info().outputPath("imported-board.png"), fullPage: true });
  const before = await (await page.request.get("/api/issues/BBB-1")).json();
  const target = page.getByRole("region", { name: "Hidden columns" }).getByRole("listitem").filter({ hasText: "In Progress" });
  await cards.filter({ hasText: "BBB-1" }).dragTo(target);
  expect((await (await page.request.get("/api/issues/BBB-1")).json()).status).toBe(before.status);
});

test.describe("通常Board", () => {
  test.use({ dataset: "empty" });
  test("実保存中はbusyと半透明で操作を保護し、完了後に戻す", async ({ page, nod }) => {
    const workspace = (await nod.me.initWorkspace({ path: nod.repo("board"), key: "API", name: "Board" })).workspace;
    const todo = await nod.me.createIssue({ workspaceId: workspace.id, title: "保存するカード" });
    const doing = await nod.me.createIssue({ workspaceId: workspace.id, title: "移動先カード" });
    await nod.me.updateIssue(todo.id, { status: "todo" });
    await nod.me.updateIssue(doing.id, { status: "in_progress" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/issues/bulk-update", async (route) => { await gate; await route.continue(); });
    await page.goto("/issues?layout=board&groupBy=none");
    const card = page.getByRole("article").filter({ hasText: todo.id });
    await card.dragTo(page.getByRole("region", { name: "In Progress", exact: true }));
    await expect(card).toHaveAttribute("aria-busy", "true");
    await expect(card).toHaveCSS("opacity", "0.5");
    await expect(card).toHaveAttribute("draggable", "false");
    await page.screenshot({ path: test.info().outputPath("saving-board.png"), fullPage: true });
    release();
    await expect(page.getByRole("region", { name: "In Progress", exact: true }).getByRole("article").filter({ hasText: todo.id })).toBeVisible();
    await expect(card).not.toHaveAttribute("aria-busy");
    await expect(card).toHaveCSS("opacity", "1");
    await expect(card).toHaveAttribute("draggable", "true");
  });
});

test.describe("現在Sprintの再取得", () => {
  test.use({ allowedConsoleErrors: [/status of 400/] });
  test("成功後のSSE再取得失敗でもエラーと最終確認時刻を示し、再試行で復帰する", async ({ page, nod }) => {
    const confirmedAt = new Date("2026-10-27T03:04:05.000Z");
    await page.clock.setFixedTime(confirmedAt);
    await page.goto("/issues");
    await waitForServerEvents(page);
    await page.getByRole("button", { name: "元A を開閉" }).click();
    const workspace = page.locator("#workspace-AAA");
    const current = workspace.getByRole("link", { name: "Current 実行 12" });
    await expect(current).toBeVisible();
    await expect(page).toHaveURL(/\/issues$/);
    let retryClicked = false;
    await page.exposeFunction("sidebarRetryClicked", () => { retryClicked = true; });
    await page.route("**/api/sprints/current", (route) => retryClicked ? route.continue() : route.fulfill({ status: 400, json: { error: { code: "INVALID_ARGS", message: "再取得失敗" } } }));
    await page.clock.setFixedTime(new Date("2026-10-27T03:05:00.000Z"));
    await nod.me.updateIssue("AAA-2", { title: "SSEで更新" });
    await expect(workspace).toContainText("取得失敗");
    await expect(workspace.getByRole("link", { name: /Current/ })).toHaveCount(0);
    await expect(workspace.locator("time")).toHaveAttribute("datetime", confirmedAt.toISOString());
    await expect(workspace).toContainText("最終確認");
    await page.screenshot({ path: test.info().outputPath("sidebar-refetch-error.png"), fullPage: true });
    const retry = workspace.getByRole("button", { name: "元A の現在Sprintを再試行" });
    await retry.evaluate((button) => {
      button.addEventListener("click", () => {
        void (window as unknown as { sidebarRetryClicked: () => Promise<void> }).sidebarRetryClicked();
      }, { once: true });
    });
    await retry.click();
    await expect(current).toBeVisible();
    await expect(workspace).not.toContainText("取得失敗");
    await current.click();
    await expect(page.getByRole("heading", { level: 1, name: "実行 12" })).toBeVisible();
  });
});

test.describe("移行履歴の親子", () => {
  test.use({ dataset: "sprint-parent-history" });
  test("保存した子非表示を共通List表とBoardで保ち、元Issue変更・削除後も写しを使う", async ({ page, nod }) => {
    await nod.me.updateIssue("AAA-2", { parentRef: null });
    await nod.me.archiveIssue("AAA-1");
    await nod.me.deleteIssue("AAA-1");
    for (const layout of ["list", "board"]) {
      await page.goto(`/sprints/1?layout=${layout}&groupBy=none`);
      const rows = layout === "board" ? page.getByRole("article") : page.locator("tr[data-issue-row]");
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText("AAA-1");
      await page.screenshot({ path: test.info().outputPath(`children-hidden-${layout}.png`), fullPage: true });
      await page.getByRole("button", { name: "表示設定", exact: true }).click();
      await page.getByRole("switch", { name: "子 Issue を表示" }).check();
      await page.getByRole("button", { name: "表示設定", exact: true }).click();
      await expect(rows).toHaveCount(3);
      await page.getByRole("button", { name: "表示設定", exact: true }).click();
      await page.getByRole("switch", { name: "子 Issue を表示" }).uncheck();
      await page.getByRole("button", { name: "表示設定", exact: true }).click();
    }
  });
});

test.describe("関連未確定の旧履歴", () => {
  test.use({ dataset: "sprint-unresolved-history" });
  test("対応する期間が0件でも取得済みの根拠を一覧から読み、元Issue削除後も区別して表示する", async ({ page, nod }) => {
    await nod.me.updateIssue("AAA-2", { title: "現在の題名" });
    await nod.me.archiveIssue("AAA-2");
    await nod.me.deleteIssue("AAA-2");
    await page.goto("/sprints");
    const history = page.getByRole("region", { name: "関連未確定の旧履歴" });
    await expect(history).toBeVisible();
    await expect(page.getByText("Sprint はまだありません", { exact: true })).toBeVisible();
    await history.locator("summary").filter({ hasText: "AAA-2" }).click();
    await expect(history).toContainText("元A（AAA）");
    await expect(history).toContainText("移行時の写し");
    await expect(history).toContainText("所属・採択は未確定");
    await expect(history).toContainText('元イベント #4');
    await expect(history).toContainText('{ "from": "過去", "to": null }');
    await expect(history).toContainText('"title": "所属なし"');
    await expect(history).not.toContainText("現在の題名");
    await history.locator("summary").filter({ hasText: "BBB-2" }).click();
    await expect(history).toContainText('"from":"削除された名前","to":"変更前の名前"');
    await page.screenshot({ path: test.info().outputPath("unresolved-history.png"), fullPage: true });
    await page.reload();
    await expect(history.locator("summary")).toHaveCount(2);
  });
});
