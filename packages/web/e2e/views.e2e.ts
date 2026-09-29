import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

test.use({ dataset: "issue-list" });

const tableRows = (page: Page) => page.getByRole("table").locator("tbody tr");
const nav = (page: Page) => page.getByRole("navigation", { name: "メイン" });

async function openFilter(page: Page) {
  await page.getByText("Filter", { exact: true }).click();
}

test("Issues の絞り込みを View として保存すると、Sidebar に出てその条件で開く", async ({ page }) => {
  await page.goto("/issues");
  await openFilter(page);
  await page.getByRole("group", { name: "Workspace" }).getByRole("checkbox", { name: "nod", exact: true }).check();
  await expect(tableRows(page)).toHaveCount(4);

  await page.getByRole("button", { name: "View として保存" }).click();
  const dialog = page.getByRole("dialog", { name: "View として保存" });
  await dialog.getByRole("textbox", { name: "名前" }).fill("nod の作業");
  await dialog.getByRole("radio", { name: "緑" }).check();
  await dialog.getByRole("button", { name: "保存" }).click();

  await expect(page).toHaveURL(/\/views\/3$/);
  await expect(page.getByRole("heading", { level: 1, name: "nod の作業" })).toBeVisible();
  await expect(tableRows(page)).toHaveCount(4);
  await expect(nav(page).getByRole("link", { name: "nod の作業" })).toHaveAttribute("aria-current", "page");
  const views = (await (await page.request.get("/api/views")).json()) as unknown[];
  expect(views.at(-1)).toMatchObject({ name: "nod の作業", color: "#0E9F6E", filter: { workspace: ["NOD"] } });
});

test("View の条件を変えて保存し、名前を変え、削除する", async ({ page }) => {
  await page.goto("/views/1");
  await expect(tableRows(page)).toHaveCount(8);
  await expect(page.getByRole("button", { name: "変更を保存" })).toHaveCount(0);

  await openFilter(page);
  await page.getByRole("group", { name: "Status" }).getByRole("checkbox", { name: "In Progress", exact: true }).check();
  await expect(tableRows(page)).toHaveCount(2);
  await page.getByRole("button", { name: "変更を保存" }).click();
  await expect(page.getByRole("button", { name: "変更を保存" })).toHaveCount(0);
  await page.reload();
  await expect(tableRows(page)).toHaveCount(2);

  await page.getByRole("button", { name: "名前を変更" }).click();
  const dialog = page.getByRole("dialog", { name: "View の名前を変更" });
  await dialog.getByRole("textbox", { name: "名前" }).fill("仕事（作業中）");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "仕事（作業中）" })).toBeVisible();
  await expect(nav(page).getByRole("link", { name: "仕事（作業中）" })).toBeVisible();

  page.once("dialog", (confirm) => void confirm.accept());
  await page.getByRole("button", { name: "削除" }).click();
  await expect(page).toHaveURL(/\/issues$/);
  await expect(nav(page).getByRole("link", { name: "仕事（作業中）" })).toHaveCount(0);
  const views = (await (await page.request.get("/api/views")).json()) as { name: string }[];
  expect(views.map((v) => v.name)).toEqual(["プライベート"]);
});

test("保存していない条件は、元に戻すか、別の View に移ると捨てる", async ({ page }) => {
  await page.goto("/views/1");
  await openFilter(page);
  await page.getByRole("group", { name: "Status" }).getByRole("checkbox", { name: "Todo", exact: true }).check();
  await expect(tableRows(page)).toHaveCount(2);
  await page.getByRole("button", { name: "元に戻す" }).click();
  await expect(tableRows(page)).toHaveCount(8);

  await page.getByRole("group", { name: "Status" }).getByRole("checkbox", { name: "Todo", exact: true }).check();
  await expect(page.getByRole("button", { name: "変更を保存" })).toBeVisible();
  await nav(page).getByRole("link", { name: "プライベート" }).click();
  await expect(tableRows(page)).toHaveCount(1);
  await nav(page).getByRole("link", { name: "仕事" }).click();
  await expect(tableRows(page)).toHaveCount(8);
  await expect(page.getByRole("button", { name: "変更を保存" })).toHaveCount(0);
});

test("空の名前と同じ名前の View は作らず、ダイアログにメッセージを出す", async ({ page }) => {
  await page.goto("/issues");
  await nav(page).getByRole("button", { name: "View を追加" }).click();
  const dialog = page.getByRole("dialog", { name: "View を作成" });
  await dialog.getByRole("button", { name: "作成" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("名前を入力してください");
  await dialog.getByRole("textbox", { name: "名前" }).fill("仕事");
  await dialog.getByRole("button", { name: "作成" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("View「仕事」はすでにあります");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(dialog).toHaveCount(0);
  const views = (await (await page.request.get("/api/views")).json()) as unknown[];
  expect(views).toHaveLength(2);
});

test("Sidebar の + で条件なしの View を作ると、その View を開く", async ({ page }) => {
  await page.goto("/inbox");
  await nav(page).getByRole("button", { name: "View を追加" }).click();
  const dialog = page.getByRole("dialog", { name: "View を作成" });
  await dialog.getByRole("textbox", { name: "名前" }).fill("すべて");
  await dialog.getByRole("button", { name: "作成" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "すべて" })).toBeVisible();
  await expect(tableRows(page)).toHaveCount(13);
});

test("存在しない View は、API を呼ばずに見つかりませんと出す", async ({ page }) => {
  await page.goto("/views/999");
  await expect(page.getByRole("heading", { level: 1, name: "View が見つかりません" })).toBeVisible();
});

test.describe("幅 1280px", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("長い名前の View でも横スクロールが出ない", async ({ page }) => {
    const name = "とても長い名前の View：仕事用のリポジトリのうち、検索と決済と通知にかかわる Issue だけを集めたもの";
    const created = await page.request.post("/api/views", { data: { name, filter: { workspace: ["API"] } } });
    expect(created.status()).toBe(201);
    const { id } = (await created.json()) as { id: number };
    await page.goto(`/views/${id}`);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    const overflow = await page.evaluate(() => {
      const main = document.querySelector("main");
      const sidebar = document.querySelector("nav");
      return {
        page: document.documentElement.scrollWidth - window.innerWidth,
        main: main ? main.scrollWidth - main.clientWidth : 0,
        sidebar: sidebar ? sidebar.scrollWidth - sidebar.clientWidth : 0,
      };
    });
    expect(overflow).toEqual({ page: 0, main: 0, sidebar: 0 });
  });
});

test("View 一覧を読み終えるまでは、どちらの入口からも View を作成できない", async ({ page }) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/views", async (route) => {
    await waiting;
    await route.continue();
  });
  try {
    await page.goto("/issues");
    const sidebarCreate = nav(page).getByRole("button", { name: "View を追加" });
    const save = page.getByRole("button", { name: "View として保存" });
    await expect(sidebarCreate).toBeDisabled();
    await expect(save).toBeDisabled();
    release();
    await expect(sidebarCreate).toBeEnabled();
    await expect(save).toBeEnabled();
  } finally {
    release();
  }
});

test.describe("View の削除失敗", () => {
  test.use({ allowedConsoleErrors: [/Failed to load resource.*status of 500/] });
  test("削除失敗を画面に表示し、未処理の Promise を残さず再試行できる", async ({ page }) => {
    await page.goto("/views/1");
    await page.route("**/api/views/1", async (route) => {
      if (route.request().method() === "DELETE") {
        await route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "削除に失敗しました" } } });
      } else await route.continue();
    });
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "削除", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("削除に失敗しました");
    await expect(page).toHaveURL(/\/views\/1$/);
    await expect(page.getByRole("button", { name: "削除", exact: true })).toBeEnabled();
    await page.unroute("**/api/views/1");
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "削除", exact: true }).click();
    await expect(page).toHaveURL(/\/issues$/);
  });
});

test("削除後の再取得でView画面が先に消えてもIssuesへ遷移する", async ({ page }) => {
  await page.goto("/views/1");
  await expect(page.getByRole("heading", { level: 1, name: "仕事" })).toBeVisible();
  let deleted = false;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/views/1", async (route) => {
    if (route.request().method() === "DELETE") {
      const response = await route.fetch();
      deleted = true;
      await route.fulfill({ response });
    } else await route.continue();
  });
  // 一覧は先に更新し、同時に無効化される別queryを保留してonSettledの解決を遅らせる。
  await page.route("**/api/workspaces", async (route) => {
    if (deleted) await waiting;
    await route.continue();
  });
  try {
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "削除", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "View が見つかりません" })).toBeVisible();
    release();
    await expect(page).toHaveURL(/\/issues$/);
    await expect(page.getByRole("heading", { level: 1, name: "Issues", exact: true })).toBeVisible();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
