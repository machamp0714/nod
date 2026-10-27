import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { closeDisplay, displaySwitch } from "./support/issue-list";

test.use({ dataset: "issue-list" });

const savedDisplays = async (page: Page) => await (await page.request.get("/api/page-displays")).json() as Record<string, unknown>;

async function restoredProject(page: Page) {
  await page.goto("/projects/1");
  await (await displaySwitch(page, "完了済み Issue を表示")).click();
  await (await displaySwitch(page, "子 Issue を表示")).click();
  await expect.poll(() => savedDisplays(page)).toMatchObject({ "project:1": { showCompleted: false, showChildren: false } });
  await page.goBack();
  await expect(await displaySwitch(page, "子 Issue を表示")).toHaveAttribute("aria-checked", "true");
  await expect(await displaySwitch(page, "完了済み Issue を表示")).toHaveAttribute("aria-checked", "false");
  await closeDisplay(page);
  // 表示記録以外の履歴stateも、同じ画面内の操作で失わない。
  await page.evaluate(() => window.history.replaceState({ ...window.history.state, projectNavigationMarker: "維持する値" }, ""));
  const before = await savedDisplays(page);
  const writes: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/page-displays/") && request.method() !== "GET") writes.push(request.method());
  });
  return { before, writes };
}

async function expectRestoredDisplay(page: Page) {
  await expect(await displaySwitch(page, "子 Issue を表示")).toHaveAttribute("aria-checked", "true");
  await expect(await displaySwitch(page, "完了済み Issue を表示")).toHaveAttribute("aria-checked", "false");
  expect(new URL(page.url()).searchParams.has("showChildren")).toBe(false);
  expect(await page.evaluate(() => window.history.state.projectNavigationMarker)).toBe("維持する値");
  await closeDisplay(page);
}

test("Projectのブロック条件だけを変えても戻るで復元した表示と保存値を保つ", async ({ page }) => {
  const { before, writes } = await restoredProject(page);
  const observations: unknown[] = [];
  const record = async (phase: string) => observations.push({ phase, url: page.url(), state: await page.evaluate(() => window.history.state), saved: await savedDisplays(page) });
  try {
    await record("履歴から復元した後");
    await page.getByRole("combobox", { name: "ブロック", exact: true }).selectOption("false");
    await record("ブロック条件だけを変更した後");
    await expectRestoredDisplay(page);
    await expect(page.getByRole("combobox", { name: "ブロック", exact: true })).toHaveValue("false");
    expect(await savedDisplays(page)).toEqual(before);
    await page.reload();
    await expectRestoredDisplay(page);
    expect(await savedDisplays(page)).toEqual(before);
    expect(writes).toEqual([]);
  } finally {
    writeFileSync(test.info().outputPath("observations.json"), JSON.stringify(observations, null, 2));
  }
});

test("Projectの一覧とフローを往復し戻る・進むでも復元した表示を保ち保存しない", async ({ page }) => {
  const { before, writes } = await restoredProject(page);
  const observations: unknown[] = [];
  const record = async (phase: string) => observations.push({ phase, url: page.url(), state: await page.evaluate(() => window.history.state), saved: await savedDisplays(page) });
  const tabs = page.getByRole("tablist", { name: "Issue の表示", exact: true });
  const list = tabs.getByRole("tab", { name: "一覧", exact: true });
  const flow = tabs.getByRole("tab", { name: "フロー", exact: true });
  try {
    await record("履歴から復元した後");
    await flow.click();
    await expect(flow).toHaveAttribute("aria-selected", "true");
    await record("フローへ切り替えた後");
    await list.click();
    await expect(list).toHaveAttribute("aria-selected", "true");
    await record("一覧へ切り替えた後");
    await expectRestoredDisplay(page);
    // 一覧/フローは従来どおりpushする。戻る・進むの各entryでも表示を保つ。
    await page.goBack();
    await expect(flow).toHaveAttribute("aria-selected", "true");
    expect(await page.evaluate(() => window.history.state.projectNavigationMarker)).toBe("維持する値");
    await page.goBack();
    await expect(list).toHaveAttribute("aria-selected", "true");
    await expectRestoredDisplay(page);
    await page.goForward();
    await expect(flow).toHaveAttribute("aria-selected", "true");
    await page.goForward();
    await expect(list).toHaveAttribute("aria-selected", "true");
    await expectRestoredDisplay(page);
    await page.reload();
    await expectRestoredDisplay(page);
    expect(await savedDisplays(page)).toEqual(before);
    expect(writes).toEqual([]);
  } finally {
    writeFileSync(test.info().outputPath("observations.json"), JSON.stringify(observations, null, 2));
  }
});
