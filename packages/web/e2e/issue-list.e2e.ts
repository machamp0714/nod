import { expect, test } from "./fixtures";
import { closeDisplay, hiddenColumn, openDisplay, searchBox, setColumn, setLayout } from "./support/issue-list";

test.use({ dataset: "issue-list" });

const tableRows = (page: import("@playwright/test").Page) => page.getByRole("table").locator("tbody tr");

test("Issues は spec の列でリストを出す", async ({ page }) => {
  await page.goto("/issues");
  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["優先度", "ID", "Status", "Title", "Project", "Workspace", "担当", "更新日時"]);
  await expect(tableRows(page)).toHaveCount(13);
  // 未決事項と PR は既定で出さず、表示設定のチップで Workspace と担当の間に出す（#196）
  await expect(table.getByRole("row", { name: /API-9/ })).not.toContainText("2 / 6");
  await setColumn(page, "未決事項", true);
  await setColumn(page, "PR", true);
  await closeDisplay(page);
  await expect(table.getByRole("columnheader")).toHaveText(["優先度", "ID", "Status", "Title", "Project", "Workspace", "未決事項", "PR", "担当", "更新日時"]);
  await expect(table.getByRole("row", { name: /API-9/ })).toContainText("2 / 6");
  await expect(table.getByRole("row", { name: /API-7/ }).getByRole("link", { name: "#128" })).toBeVisible();
});

test("件数はタブに出し、Ready のタブで絞り込み、All のタブで戻す（件数カードは出さない）", async ({ page }) => {
  await page.goto("/issues");
  const tabs = page.getByRole("tablist", { name: "絞り込み" });
  await expect(tabs.getByRole("tab")).toHaveText(["All 13", "Ready 2", "Needs Clarification 1", "委任中 4"]);
  // 件数カード（タブと同じ件数を示すボタン）は置かない
  await expect(page.getByRole("button", { name: /^Ready/ })).toHaveCount(0);
  const ready = tabs.getByRole("tab", { name: "Ready 2", exact: true });
  await ready.click();
  await expect(page).toHaveURL(/tab=ready/);
  await expect(ready).toHaveAttribute("aria-selected", "true");
  await expect(tableRows(page)).toHaveCount(2);
  await tabs.getByRole("tab", { name: "All 13", exact: true }).click();
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
  await expect((await openDisplay(page)).getByRole("tablist", { name: "表示" }).getByRole("tab", { name: "List" })).toHaveAttribute("aria-selected", "true");
  await expect(tableRows(page)).toHaveCount(13);
});

test("検索語でタイトルと ID を絞り込む", async ({ page }) => {
  await page.goto("/issues");
  const search = await searchBox(page);
  await search.fill("N+1");
  await expect(tableRows(page)).toHaveCount(1);
  await expect(tableRows(page)).toContainText("API-12");
  await search.fill("nod-5");
  await expect(tableRows(page)).toHaveCount(1);
  await expect(tableRows(page)).toContainText("Inbox の回答フォームを作る");
  await search.fill("該当しない語");
  await expect(page.getByText("該当する Issue はありません")).toBeVisible();
});

test("検索欄に IME で日本語を入力できる（変換中に URL の更新で入力が崩れない）", async ({ page }) => {
  await page.goto("/issues");
  const search = await searchBox(page);
  const cdp = await page.context().newCDPSession(page);
  // ローマ字入力の途中経過を1文字ずつ送り、最後に確定する
  for (const text of ["k", "き", "きゃ", "きゃr", "きゃり"]) {
    await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  }
  await cdp.send("Input.insertText", { text: "キャリ" });
  await expect(search).toHaveValue("キャリ");
  await expect(page).toHaveURL(/q=%E3%82%AD%E3%83%A3%E3%83%AA/);
});

test("Board は6つの Status を列か Hidden columns に出し、Triage と Canceled を出さない", async ({ page, nod }) => {
  await page.goto("/issues");
  await setLayout(page, "Board");
  await closeDisplay(page);
  await expect(page).toHaveURL(/layout=board/);
  for (const name of ["Needs Clarification", "Backlog", "Todo", "In Progress", "In Review", "Done"]) {
    await expect(page.getByRole("region", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("region", { name: "Hidden columns", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Triage", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Canceled", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "In Progress", exact: true }).getByRole("link")).toHaveCount(3);

  // Issue が 0 件になった列は、右端の Hidden columns に件数 0 の行としてまとまる。Triage と Canceled はここにも出ない
  await expect(page.getByRole("region", { name: "Needs Clarification", exact: true }).getByRole("article")).toHaveCount(1);
  await nod.me.updateIssue("API-9", { status: "canceled" });
  await expect(page.getByRole("region", { name: "Needs Clarification", exact: true })).toHaveCount(0);
  const hidden = page.getByRole("region", { name: "Hidden columns", exact: true });
  await expect(hidden.getByRole("listitem")).toHaveText(["Needs Clarification0"]);
  await expect(hiddenColumn(page, "Needs Clarification")).toBeVisible();
  // トグルで行をたたみ、もう一度押すと開く
  const toggle = hidden.getByRole("button", { name: "Hidden columns", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(hidden.getByRole("listitem")).toHaveCount(0);
  await toggle.click();
  await expect(hidden.getByRole("listitem")).toHaveCount(1);
});

test.describe("Issue 詳細", () => {
  test.use({ dataset: "issue-detail" });

  test("タイトルを押すと Issue 詳細に移る", async ({ page }) => {
    await page.goto("/issues");
    await page.getByRole("link", { name: "検索 API の N+1 を解消" }).click();
    await expect(page).toHaveURL(/\/issues\/API-12$/);
  });
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

test("Project 詳細は説明と Documents を出し、空の列を Hidden columns にまとめる", async ({ page }) => {
  await page.goto("/projects/3?layout=board");
  await expect(page.getByRole("heading", { level: 1, name: "nod Web UI" })).toBeVisible();
  await expect(page.getByText("判断のための画面")).toBeVisible();
  await expect(page.getByRole("link", { name: "nod 設計" })).toHaveAttribute("href", "/documents/3");
  await expect(page.getByRole("region", { name: "Done", exact: true })).toHaveCount(0);
  await expect(hiddenColumn(page, "Done")).toContainText("0");
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
