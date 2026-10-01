import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { chooseDisplay, displaySelect, searchBox } from "./support/issue-list";

test.use({ dataset: "issue-list" });

const tableRows = (page: Page) => page.getByRole("table").locator("tbody tr");
const nav = (page: Page) => page.getByRole("navigation", { name: "メイン" });

// 「変更あり」のピルが見えているか。収まらないときは、高さ 20 の箱の2行目へ折り返して隠す（箱の overflow で切る）ため、
// Playwright の可視判定ではなく、ピルが箱の中にあるかを位置で確かめる
async function dirtyPillShown(page: Page): Promise<boolean> {
  const pill = page.getByText("変更あり", { exact: true });
  await expect(pill).toHaveCount(1);
  return pill.evaluate((el) => {
    const box = el.parentElement!.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.top < box.bottom && rect.right <= box.right + 0.5;
  });
}

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

  test("Header に収まらないときは「変更あり」のピルを隠し、「元に戻す」「変更を保存」は出す", async ({ page }) => {
    const name = "とても長い名前の View：仕事用のリポジトリのうち、検索と決済と通知にかかわる Issue だけを集めたもの";
    const created = await page.request.post("/api/views", { data: { name, filter: { workspace: ["API"] } } });
    const { id } = (await created.json()) as { id: number };
    await page.goto(`/views/${id}?sort=priority`);
    await expect(page.getByRole("button", { name: "元に戻す" })).toBeVisible();
    await expect(page.getByRole("button", { name: "変更を保存" })).toBeVisible();
    expect(await dirtyPillShown(page)).toBe(false);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBe(0);

    // 短い名前の View は同じ幅でもピルを出す
    await page.goto("/views/1?sort=priority");
    await expect(page.getByRole("button", { name: "変更を保存" })).toBeVisible();
    expect(await dirtyPillShown(page)).toBe(true);
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

test.describe("View の表示設定（#175）", () => {
  const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
  const lastView = async (page: Page) => ((await (await page.request.get("/api/views")).json()) as { id: number; filter: unknown; display: unknown }[]).at(-1)!;

  test("タブ・グループ・並び順も View として保存し、開き直すと同じ表示になる", async ({ page }) => {
    await page.goto("/issues?tab=ready&groupBy=workspace&sort=priority&workspace=API");
    await page.getByRole("button", { name: "View として保存" }).click();
    const dialog = page.getByRole("dialog", { name: "View として保存" });
    const summary = dialog.getByRole("region", { name: "保存する内容" });
    await expect(summary).toContainText("Workspaceapi-server");
    await expect(summary).toContainText("タブ Ready ／ グループ Workspace ／ 並び 優先度（昇順）");
    await expect(dialog.getByText("保存しません")).toHaveCount(0);
    await dialog.getByRole("textbox", { name: "名前" }).fill("API の Ready");
    await dialog.getByRole("button", { name: "保存" }).click();

    await expect(page).toHaveURL(/\/views\/3$/);
    expect(await lastView(page)).toMatchObject({ filter: { workspace: ["API"] }, display: { tab: "ready", groupBy: "workspace", sort: "priority" } });
    await expect(page.getByRole("tab", { name: /^Ready / })).toHaveAttribute("aria-selected", "true");
    await expect(region(page, "Workspace API")).toBeVisible();
    await expect(await displaySelect(page, "並び順")).toHaveAttribute("data-value", "priority");
    await expect(page.getByText("変更あり", { exact: true })).toHaveCount(0);

    // Sidebar から開き直しても、再読み込みしても同じ表示
    await nav(page).getByRole("link", { name: "仕事", exact: true }).click();
    await nav(page).getByRole("link", { name: "API の Ready" }).click();
    await expect(page).toHaveURL(/\/views\/3$/);
    await expect(page.getByRole("tab", { name: /^Ready / })).toHaveAttribute("aria-selected", "true");
    await page.reload();
    await expect(region(page, "Workspace API")).toBeVisible();
  });

  test("条件も表示設定もなければ「条件なし」「既定の表示」と出し、検索欄の入力とプレビューは保存しないと明示する", async ({ page }) => {
    await page.goto("/issues");
    await page.getByRole("button", { name: "View として保存" }).click();
    const dialog = page.getByRole("dialog", { name: "View として保存" });
    await expect(dialog.getByRole("region", { name: "保存する内容" })).toContainText("条件なし（すべての Issue）");
    await expect(dialog.getByRole("region", { name: "保存する内容" })).toContainText("既定の表示");
    await expect(dialog.getByText("保存しません")).toHaveCount(0);
    await dialog.getByRole("button", { name: "キャンセル" }).click();

    await page.goto("/issues?q=API&layout=board");
    await page.getByRole("button", { name: "View として保存" }).click();
    await expect(dialog.getByRole("region", { name: "保存する内容" })).toContainText("表示 ボード");
    await expect(dialog.getByText("検索欄の入力「API」は保存しません")).toBeVisible();
    await dialog.getByRole("textbox", { name: "名前" }).fill("ボード");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(page).toHaveURL(/\/views\/3$/);
    expect(await lastView(page)).toMatchObject({ filter: {}, display: { layout: "board" } });
  });

  test("View を開いたまま表示設定を変えると「変更あり」になり、保存すると URL から消えて次も同じ表示で開く", async ({ page }) => {
    await page.goto("/views/1");
    await expect(page.getByText("変更あり", { exact: true })).toHaveCount(0);
    await chooseDisplay(page, "グループ化", "Workspace");
    await expect(page).toHaveURL(/groupBy=workspace/);
    await expect(page.getByText("変更あり", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "変更を保存" }).click();
    await expect(page.getByText("変更あり", { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/\/views\/1$/);
    await expect(region(page, "Workspace API")).toBeVisible();
    const saved = ((await (await page.request.get("/api/views/1")).json()) as { display: unknown }).display;
    expect(saved).toEqual({ groupBy: "workspace" });

    // 保存した表示設定を既定に戻す操作も「変更あり」になり、URL に明示して復元できる
    await chooseDisplay(page, "グループ化", "なし");
    await expect(page).toHaveURL(/groupBy=none/);
    await expect(region(page, "Workspace API")).toHaveCount(0);
    await page.reload();
    await expect(region(page, "Workspace API")).toHaveCount(0);
    await expect(page.getByText("変更あり", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "元に戻す" }).click();
    await expect(page).toHaveURL(/\/views\/1$/);
    await expect(region(page, "Workspace API")).toBeVisible();
    await expect(page.getByText("変更あり", { exact: true })).toHaveCount(0);
  });

  test("URL に明示した表示設定は View の表示設定より優先し、検索とプレビューは変更ありに数えない", async ({ page }) => {
    const created = await page.request.post("/api/views", { data: { name: "ボード", display: { layout: "board", tab: "ready" } } });
    const { id } = (await created.json()) as { id: number };
    await page.goto(`/views/${id}`);
    await expect(page.getByRole("tab", { name: /^Ready / })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("table")).toHaveCount(0);
    await (await searchBox(page)).fill("API");
    await expect(page.getByText("変更あり", { exact: true })).toHaveCount(0);
    await page.goto(`/views/${id}?layout=list&tab=all`);
    await expect(page.getByRole("tab", { name: /^All / })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByText("変更あり", { exact: true })).toBeVisible();
  });

  test("API で既定と同じ列（順だけ違うものも）を保存した View は、開いても「変更あり」にならない", async ({ page }) => {
    const columns = ["pr", "assignee", "project", "workspace", "questions", "status", "priority"];
    const created = await page.request.post("/api/views", { data: { name: "既定の列", display: { columns, groupBy: "workspace" } } });
    const { id } = (await created.json()) as { id: number };
    expect(((await (await page.request.get(`/api/views/${id}`)).json()) as { display: { columns?: string[] } }).display.columns).toHaveLength(7);
    await page.goto(`/views/${id}`);
    await expect(region(page, "Workspace API")).toBeVisible();
    await expect(page.getByText("変更あり", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "変更を保存" })).toHaveCount(0);
  });

  test("View の画面で委任中タブのまま保存すると、filter の delegated と担当のグループ化で保存し、URL から tab が消える", async ({ page }) => {
    await page.goto("/views/1");
    await page.getByRole("tab", { name: /^委任中 / }).click();
    await expect(page).toHaveURL(/tab=delegated/);
    await expect(page.getByText("変更あり", { exact: true })).toBeVisible();
    await expect(region(page, "担当 claude-code")).toBeVisible();
    const delegatedRows = await tableRows(page).count();
    expect(delegatedRows).toBeGreaterThan(0);
    await page.getByRole("button", { name: "変更を保存" }).click();
    await expect(page.getByRole("button", { name: "変更を保存" })).toHaveCount(0);
    await expect(page).toHaveURL(/\/views\/1$/);
    const saved = (await (await page.request.get("/api/views/1")).json()) as { filter: Record<string, unknown>; display: unknown };
    expect(saved.filter).toMatchObject({ delegated: true });
    expect(saved.display).toEqual({ groupBy: "assignee" });
    // 保存後は All タブで、委任中だけを担当でまとめて出す（表示される Issue は同じ）
    await expect(page.getByRole("tab", { name: /^All / })).toHaveAttribute("aria-selected", "true");
    await expect(tableRows(page)).toHaveCount(delegatedRows);
    await expect(page.getByText("変更あり", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page).toHaveURL(/\/views\/1$/);
    await expect(tableRows(page)).toHaveCount(delegatedRows);
    await expect(page.getByText("変更あり", { exact: true })).toHaveCount(0);
  });

  test("表示設定を保存したあと、ブラウザの戻る・進むでも保存した表示で開き「変更あり」にならない", async ({ page }) => {
    await page.goto("/views/1");
    await chooseDisplay(page, "並び順", "優先度");
    await expect(page).toHaveURL(/sort=priority/);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "変更を保存" }).click();
    await expect(page.getByRole("button", { name: "変更を保存" })).toHaveCount(0);
    await expect(page).toHaveURL(/\/views\/1$/);

    // 並び順の変更は履歴に積むため、戻った先は保存前の /views/1（表示設定のクエリなし）。保存した並び順で開く
    await page.goBack();
    await expect(page).toHaveURL(/\/views\/1$/);
    await expect(await displaySelect(page, "並び順")).toHaveAttribute("data-value", "priority");
    await expect(page.getByText("変更あり", { exact: true })).toHaveCount(0);
    await page.goForward();
    await expect(page).toHaveURL(/\/views\/1$/);
    await expect(await displaySelect(page, "並び順")).toHaveAttribute("data-value", "priority");
    await expect(page.getByText("変更あり", { exact: true })).toHaveCount(0);
  });
});
