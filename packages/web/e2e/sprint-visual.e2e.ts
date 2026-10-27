import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";

test.use({ dataset: "sprint-history" });

test("承認v3のSidebar・現在View・保存・共通一覧をブラウザで確認する", async ({ page }, testInfo) => {
  const output = process.env.TASK3_UI_OUT ?? testInfo.outputPath("task3-ui");
  mkdirSync(output, { recursive: true });
  await page.goto("/views/1");
  await expect(page.locator("tr[data-issue-row]")).toHaveCount(8);
  await page.getByRole("button", { name: "元A を開閉" }).click();
  const nav = page.getByRole("navigation", { name: "メイン" });
  const metrics = await nav.evaluate((node) => ({ width: node.getBoundingClientRect().width, rows: [...node.querySelectorAll("a")].map((item) => item.getBoundingClientRect().height) }));
  expect(metrics.width).toBe(244);
  expect(metrics.rows.filter((height) => height !== 22)).toEqual(expect.arrayContaining([28]));
  await page.screenshot({ path: join(output, "current-view.png"), fullPage: true });
  await page.getByRole("button", { name: "元A を開閉" }).click();
  await page.screenshot({ path: join(output, "sidebar-collapsed.png"), fullPage: true });

  await page.goto('/issues?sprint=current&groupBy=status&columns=["priority","status","workspace","sprint","project","assignee"]');
  await page.getByRole("button", { name: "View として保存", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "名前" }).fill("現行Sprintの全タスク");
  await page.screenshot({ path: join(output, "save-dialog.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "View として保存", exact: true })).toBeFocused();

  await page.goto("/sprints/12");
  await expect(page.locator("tr[data-issue-row]")).toHaveCount(7);
  await page.getByRole("button", { name: "元A を開閉" }).click();
  await page.screenshot({ path: join(output, "current-detail.png"), fullPage: true });
  await page.goto("/cycles/1");
  await expect(page.getByRole("heading", { level: 1, name: "過去" })).toBeVisible();
  await page.screenshot({ path: join(output, "imported-detail.png"), fullPage: true });
  await page.getByRole("button", { name: "分析", exact: true }).click();
  await expect(page.getByText("timezoneが未記録のため推移は不明", { exact: true })).toBeVisible();
  await page.screenshot({ path: join(output, "imported-analytics.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "分析", exact: true })).toBeFocused();

  for (const width of [800, 480]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto("/views/1");
    await expect(page.locator("tr[data-issue-row]")).toHaveCount(8);
    const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - innerWidth, main: document.querySelector("main")!.scrollWidth - document.querySelector("main")!.clientWidth }));
    await page.screenshot({ path: join(output, `current-view-${width}.png`), fullPage: true });
    if (overflow.main) console.log("はみ出しの測定", width, await page.locator("main").evaluate((main) => [...main.querySelectorAll("*")].filter((item) => item.getBoundingClientRect().right > main.getBoundingClientRect().right).slice(0, 12).map((item) => ({ tag: item.tagName, class: item.className, text: item.textContent?.slice(0, 40), width: item.getBoundingClientRect().width }))));
    expect(overflow).toEqual({ page: 0, main: 0 });
  }
});
