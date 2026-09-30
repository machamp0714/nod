import { expect, test, waitForServerEvents } from "./fixtures";

test.use({ dataset: "issue-list" });
type Page = import("@playwright/test").Page;
const input = (page: Page) => page.getByRole("textbox", { name: "進捗報告の本文" });
const records = (page: Page) => page.getByRole("article", { name: "進捗報告の記録" });
const current = (page: Page) => page.getByLabel("現在の健全性");

async function chooseHealth(page: Page, label: string) {
  await page.getByRole("button", { name: /^健全性: / }).click();
  await page.getByRole("listbox", { name: "健全性" }).getByRole("option").filter({ hasText: label }).getByRole("button").click();
}

test("進捗報告に健全性を添えると、報告ごとの健全性と Project の現在の健全性に反映する", async ({ page, nod }) => {
  await page.goto("/projects/1?q=API");
  await expect(current(page)).toHaveText("未設定");
  await expect(page.getByRole("button", { name: "健全性: 未指定" })).toBeVisible();

  await chooseHealth(page, "At risk");
  await expect(page.getByRole("button", { name: "健全性: At risk" })).toBeVisible();
  await input(page).fill("インデックス追加が遅れている");
  await page.getByRole("button", { name: "報告する" }).click();
  await expect(records(page)).toHaveCount(1);
  await expect(records(page).first().locator("[data-health]")).toHaveText("At risk");
  await expect(current(page)).toHaveText("At risk");
  // 送信後は「未指定」に戻り、次の報告に前の健全性を持ち越さない
  await expect(page.getByRole("button", { name: "健全性: 未指定" })).toBeVisible();

  await input(page).fill("メモだけ");
  await page.getByRole("button", { name: "報告する" }).click();
  await expect(records(page)).toHaveCount(2);
  // 健全性のない報告には Pill を出さない（未設定に戻したように読めないように。#154）
  await expect(records(page).first().locator("[data-health]")).toHaveCount(0);
  await expect(current(page)).toHaveText("At risk");
  await expect(page).toHaveURL(/q=API/);

  const project = await nod.me.getProject("1");
  expect(project.health).toBe("at_risk");
  expect(project.updates.map((u) => [u.body, u.health])).toEqual([["メモだけ", null], ["インデックス追加が遅れている", "at_risk"]]);

  await page.goto("/projects?tab=all");
  const row = (name: string) => page.getByRole("row").filter({ has: page.getByRole("link", { name, exact: true }) });
  await expect(page.getByRole("columnheader", { name: "健全性" })).toBeVisible();
  await expect(row(project.name).locator("[data-health]")).toHaveText("At risk");
  await expect(row((await nod.me.getProject("2")).name).locator("[data-health]")).toHaveText("未設定");
});

test("「未設定に戻す」を添えた報告で現在の健全性を未設定に戻し、報告に「未設定に戻しました」を出す（#154）", async ({ page, nod }) => {
  await nod.codex.addProjectUpdate("1", "遅延が確定", "off_track");
  await page.goto("/projects/1");
  await expect(current(page)).toHaveText("Off track");
  await page.getByRole("button", { name: /^健全性: / }).click();
  const menu = page.getByRole("listbox", { name: "健全性" });
  await expect(menu.getByRole("option")).toHaveText(["未指定", "On track", "At risk", "Off track", "未設定に戻す"]);
  await menu.getByRole("option").filter({ hasText: "未設定に戻す" }).getByRole("button").click();
  await expect(page.getByRole("button", { name: "健全性: 未設定に戻す" })).toBeVisible();
  await input(page).fill("判断を保留");
  await page.getByRole("button", { name: "報告する" }).click();
  await expect(records(page)).toHaveCount(2);
  await expect(records(page).first().locator("[data-health]")).toHaveText("未設定に戻しました");
  await expect(current(page)).toHaveText("未設定");
  await expect(page.getByRole("button", { name: "健全性: 未指定" })).toBeVisible();
  const project = await nod.me.getProject("1");
  expect(project.health).toBeNull();
  expect(project.updates.map((u) => [u.body, u.health, u.healthCleared])).toEqual([["判断を保留", null, true], ["遅延が確定", "off_track", false]]);
});

test("LLM が健全性つきで書いた報告が SSE で開いた詳細に反映し、書きかけの下書きと選択を保つ", async ({ page, nod }) => {
  await page.goto("/projects/1");
  await waitForServerEvents(page);
  await input(page).fill("書きかけ");
  await chooseHealth(page, "On track");
  await nod.codex.addProjectUpdate("1", "遅延が確定", "off_track");
  await expect(records(page)).toHaveCount(1);
  await expect(records(page).first()).toContainText("codex");
  await expect(records(page).first().locator("[data-health]")).toHaveText("Off track");
  await expect(current(page)).toHaveText("Off track");
  await expect(input(page)).toHaveValue("書きかけ");
  await expect(page.getByRole("button", { name: "健全性: On track" })).toBeVisible();
});

test.describe("保存の失敗", () => {
  test.use({ allowedConsoleErrors: [/status of 400/] });
  test("失敗しても本文と健全性の選択を残し、再試行で保存できる", async ({ page, nod }) => {
    await page.route("**/api/projects/1/reports", (route) =>
      route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "INVALID_ARGS", message: "保存に失敗しました" } }) }),
    );
    await page.goto("/projects/1");
    await chooseHealth(page, "Off track");
    await input(page).fill("下書き");
    await page.getByRole("button", { name: "報告する" }).click();
    await expect(page.getByRole("alert")).toHaveText("保存できませんでした：保存に失敗しました");
    await expect(input(page)).toHaveValue("下書き");
    await expect(page.getByRole("button", { name: "健全性: Off track" })).toBeVisible();
    await page.unroute("**/api/projects/1/reports");
    await page.getByRole("button", { name: "報告する" }).click();
    await expect(records(page)).toHaveCount(1);
    await expect(current(page)).toHaveText("Off track");
    expect((await nod.me.getProject("1")).updates.map((u) => [u.body, u.health])).toEqual([["下書き", "off_track"]]);
  });
});
