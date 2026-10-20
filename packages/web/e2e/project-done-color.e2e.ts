import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// design/nod.pen「Project詳細｜一覧（正本）」（DOM7I）：Project 詳細の完了チェックは ready 色（#16794B）。他画面は既存の色のまま
const READY = "rgb(22, 121, 75)";
const INK3 = "rgb(138, 145, 158)";
const ACCENT = "rgb(63, 81, 216)";

test.use({ dataset: "issue-list" });

const statusIcon = (page: Page, id: string, name: string): Locator =>
  page.locator(`[data-issue-row="${id}"]`).locator(`[title="${name}"] svg`);

test.beforeEach(async ({ nod }) => {
  await nod.me.updateIssue("API-12", { status: "done" });
  await nod.me.updateIssue("API-13", { status: "canceled", reason: "まとめて対応した" });
  await nod.me.updateIssue("API-9", { status: "in_progress" });
});

test("Project 詳細の表で、完了だけを緑のチェックにし、状態名を支援技術に残す", async ({ page }) => {
  await page.goto("/projects/1");
  const done = statusIcon(page, "API-12", "Done");
  await expect(done).toHaveCSS("stroke", READY);
  await expect(page.locator('[data-issue-row="API-12"]').getByText("Done", { exact: true })).toBeAttached();
  await expect(statusIcon(page, "API-13", "Canceled")).toHaveCSS("stroke", INK3);
  await expect(statusIcon(page, "API-9", "In Progress")).toHaveCSS("stroke", ACCENT);
  // 行のホバーと選択の背景でも色を変えない
  await page.locator('[data-issue-row="API-12"]').hover();
  await expect(done).toHaveCSS("stroke", READY);
  await page.getByRole("checkbox", { name: "API-12 を選択", exact: true }).check();
  await expect(done).toHaveCSS("stroke", READY);
});

test("Project 詳細の Status の見出しと Board でも、完了を緑のチェックにする", async ({ page }) => {
  await page.goto("/projects/1?groupBy=status");
  const doneGroup = page.getByRole("region", { name: "Status Done", exact: true });
  await expect(doneGroup.getByRole("heading", { name: /Done/ }).locator("svg")).toHaveCSS("stroke", READY);
  await expect(page.getByRole("region", { name: "Status Canceled", exact: true }).getByRole("heading").locator("svg")).toHaveCSS("stroke", INK3);

  await page.goto("/projects/1?layout=board");
  const column = page.getByRole("region", { name: "Done", exact: true });
  await expect(column.getByRole("heading", { name: "Done", exact: true })).toBeVisible();
  await expect(column.locator("header svg")).toHaveCSS("stroke", READY);
  const card = column.getByRole("link", { name: "検索 API の N+1 を解消", exact: true });
  await expect(card.locator("xpath=preceding-sibling::span//*[local-name()='svg']")).toHaveCSS("stroke", READY);
  await expect(page.getByRole("region", { name: "In Progress", exact: true }).locator("header svg")).toHaveCSS("stroke", ACCENT);
});

test("Project 詳細で完了を隠すと完了の行は出ず、未完了の色は変わらない", async ({ page }) => {
  await page.goto("/projects/1?showCompleted=false");
  await expect(statusIcon(page, "API-9", "In Progress")).toHaveCSS("stroke", ACCENT);
  await expect(page.locator('[data-issue-row="API-12"]')).toHaveCount(0);
});

test("Project 詳細のプレビューと Project 詳細の外では、完了のチェックは既存の色のまま", async ({ page, nod }) => {
  await page.goto("/projects/1?preview=API-12");
  await expect(page.getByRole("complementary", { name: "API-12 のプレビュー" }).locator("svg.lucide-circle-check")).toHaveCSS("stroke", INK3);
  await nod.me.updateIssue("API-13", { status: "done" });
  await page.goto("/issues/API-12");
  await expect(page.getByRole("region", { name: "Sub-issue", exact: true }).locator("svg.lucide-circle-check")).toHaveCSS("stroke", INK3);
  await page.goto("/issues");
  await expect(statusIcon(page, "API-12", "Done")).toHaveCSS("stroke", INK3);
  await page.goto("/issues?layout=board");
  await expect(page.getByRole("region", { name: "Done", exact: true }).locator("header svg")).toHaveCSS("stroke", INK3);
});
