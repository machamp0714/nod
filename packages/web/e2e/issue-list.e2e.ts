import { expect, test } from "./fixtures";

test.use({ dataset: "issue-list" });

const tableRows = (page: import("@playwright/test").Page) => page.getByRole("table").locator("tbody tr");

test("Issues は spec の列でリストを出す", async ({ page }) => {
  await page.goto("/issues");
  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["Status", "ID", "Title", "未決事項", "Workspace", "PR"]);
  await expect(tableRows(page)).toHaveCount(13);
  await expect(table.getByRole("row", { name: /API-9/ })).toContainText("2 / 6");
  await expect(table.getByRole("row", { name: /API-7/ }).getByRole("link", { name: "#128" })).toBeVisible();
});

test("件数カードを押すと Ready で絞り込み、もう一度押すと戻す", async ({ page }) => {
  await page.goto("/issues");
  const card = page.getByRole("button", { name: "Ready 2" });
  await card.click();
  await expect(page).toHaveURL(/tab=ready/);
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await expect(tableRows(page)).toHaveCount(2);
  await expect(page.getByRole("tablist", { name: "絞り込み" }).getByRole("tab", { name: /^Ready/ })).toHaveAttribute("aria-selected", "true");
  await card.click();
  await expect(page).not.toHaveURL(/tab=/);
  await expect(tableRows(page)).toHaveCount(13);
});

test("Needs Clarification のタブは未決事項の残る Issue だけを出す", async ({ page }) => {
  await page.goto("/issues");
  await page.getByRole("tablist", { name: "絞り込み" }).getByRole("tab", { name: /^Needs Clarification/ }).click();
  await expect(page).toHaveURL(/tab=needs_clarification/);
  await expect(tableRows(page)).toHaveCount(1);
  await expect(tableRows(page)).toContainText("API-9");
});

test("不正な tab と layout は All と List に戻す", async ({ page }) => {
  await page.goto("/issues?tab=foo&layout=grid");
  await expect(page.getByRole("tablist", { name: "絞り込み" }).getByRole("tab", { name: /^All/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tablist", { name: "表示" }).getByRole("tab", { name: "List" })).toHaveAttribute("aria-selected", "true");
  await expect(tableRows(page)).toHaveCount(13);
});

test("検索語でタイトルと ID を絞り込む", async ({ page }) => {
  await page.goto("/issues");
  const search = page.getByRole("textbox", { name: "検索" });
  await search.fill("N+1");
  await expect(tableRows(page)).toHaveCount(1);
  await expect(tableRows(page)).toContainText("API-12");
  await search.fill("nod-5");
  await expect(tableRows(page)).toHaveCount(1);
  await expect(tableRows(page)).toContainText("Inbox の回答フォームを作る");
  await search.fill("該当しない語");
  await expect(page.getByText("該当する Issue はありません")).toBeVisible();
});

test("Board は6つの列を出し、Triage と Canceled を出さない", async ({ page }) => {
  await page.goto("/issues");
  await page.getByRole("tablist", { name: "表示" }).getByRole("tab", { name: "Board" }).click();
  await expect(page).toHaveURL(/layout=board/);
  for (const name of ["Needs Clarification", "Backlog", "Todo", "In Progress", "In Review", "Done"]) {
    await expect(page.getByRole("region", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("region", { name: "Triage", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Canceled", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "In Progress", exact: true }).getByRole("link")).toHaveCount(3);
});

test("タイトルを押すと Issue 詳細に移る", async ({ page }) => {
  await page.goto("/issues");
  await page.getByRole("link", { name: "検索 API の N+1 を解消" }).click();
  await expect(page).toHaveURL(/\/issues\/API-12$/);
});

test("View は保存した条件に合う Issue だけを出す", async ({ page }) => {
  await page.goto("/views/1");
  await expect(page.getByRole("heading", { level: 1, name: "仕事" })).toBeVisible();
  await expect(tableRows(page)).toHaveCount(8);
  for (const text of await tableRows(page).allTextContents()) expect(text).toContain("API-");
});

test("存在しない View は見つかりませんと出す", async ({ page }) => {
  await page.goto("/views/999");
  await expect(page.getByRole("heading", { level: 1, name: "View が見つかりません" })).toBeVisible();
});

test("Project 詳細は説明と Documents を出し、空の列にまだありませんと出す", async ({ page }) => {
  await page.goto("/projects/3?layout=board");
  await expect(page.getByRole("heading", { level: 1, name: "nod Web UI" })).toBeVisible();
  await expect(page.getByText("判断のための画面")).toBeVisible();
  await expect(page.getByRole("link", { name: "nod 設計" })).toHaveAttribute("href", "/documents/3");
  await expect(page.getByRole("region", { name: "Done", exact: true })).toContainText("まだありません");
});

test("存在しない Project は見つかりませんと出す", async ({ page }) => {
  await page.goto("/projects/999");
  await expect(page.getByRole("heading", { level: 1, name: "Project が見つかりません" })).toBeVisible();
});

test.describe("幅 1280px", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const path of ["/issues", "/issues?layout=board", "/inbox"]) {
    test(`${path} は長いタイトルでも横スクロールが出ない`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => {
        const main = document.querySelector("main");
        return {
          page: document.documentElement.scrollWidth - window.innerWidth,
          main: main ? main.scrollWidth - main.clientWidth : 0,
        };
      });
      expect(overflow).toEqual({ page: 0, main: 0 });
    });
  }
});
