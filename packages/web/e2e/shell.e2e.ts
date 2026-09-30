import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// シェルの寸法（#178）とコントロールの型（#179）。design/nod.pen の Sidebar（mgInh）と各画面の Card に合わせる。
// 画面は playwright.config.ts の 1440×960 で開く
test.use({ dataset: "issue-list" });

const SIDEBAR_WIDTH = 244;
const NAV_ITEM_HEIGHT = 28;
const HEADER_HEIGHT = 44;
const VIEW_BAR_HEIGHT = 43;
const MAIN_MARGIN = 8;
const MAIN_RADIUS = "12px";
const PILL_RADIUS = "9999px";

// 各画面の Header。Document は本文にも <header> があるため、パンくずの <nav> を含めて先頭を取る
const PAGE_HEADER = ':is(header, nav[aria-label="パンくず"])';

async function measure(page: Page) {
  return page.evaluate((headerSelector) => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const main = document.querySelector("main");
    const sidebar = document.querySelector('nav[aria-label="メイン"]');
    const mainRect = rect(main);
    return {
      sidebarWidth: rect(sidebar)?.width,
      navItemHeight: rect(sidebar?.querySelector("a[href='/inbox']") ?? null)?.height,
      headerHeight: rect(main?.querySelector(headerSelector) ?? null)?.height,
      main: mainRect && {
        left: mainRect.x,
        top: mainRect.y,
        right: window.innerWidth - mainRect.right,
        bottom: window.innerHeight - mainRect.bottom,
        radius: main ? getComputedStyle(main).borderTopLeftRadius : null,
      },
      overflow: {
        page: document.documentElement.scrollWidth - window.innerWidth,
        pageY: document.documentElement.scrollHeight - window.innerHeight,
        main: main ? main.scrollWidth - main.clientWidth : 0,
      },
    };
  }, PAGE_HEADER);
}

// Main の中で selector に合う要素が n 個になるまで待つ。はみ出しは中身（表の行、select の選択肢）が出てから測る
const count = (selector: string, n: number) => async (page: Page) => {
  await expect(page.locator("main").locator(selector)).toHaveCount(n);
};
const text = (value: string) => async (page: Page) => {
  await expect(page.locator("main").getByText(value)).toBeVisible();
};

interface Route {
  name: string;
  open?: (page: Page) => Promise<void>; // 省いたら name を開く
  ready: ((page: Page) => Promise<void>)[];
}

const ROUTES: Route[] = [
  { name: "/inbox", ready: [count('section[aria-label="確認依頼の一覧"] a', 3), count('section[aria-label="詳細"] h2', 1)] },
  // プロパティ欄はピル型ボタン（#180）。ピルの幅は今の値だけで決まる（選択肢の一覧に左右されない）ため、ピルと行が出てから測る
  { name: "/inbox?tab=notifications", ready: [count('section[aria-label="プロパティ"] button[aria-label="Project"]', 1), count('section[aria-label="プロパティ"] dl > div', 10)] },
  { name: "/reviews", ready: [count('section[aria-label="完了報告"]', 1)] },
  { name: "/triage", ready: [count('select[aria-label="受け入れ時のProject"] option', 6)] },
  { name: "/issues", ready: [count("table tbody tr", 13), count('select[aria-label="Project"] option', 6)] },
  { name: "/issues?layout=board", ready: [count("article", 10)] },
  {
    name: "/issues/<id>",
    open: async (page) => {
      await page.goto("/issues");
      await page.locator("main a[href^='/issues/']").first().click();
      await expect(page).toHaveURL(/\/issues\/[^/?]+$/);
    },
    ready: [count('section[aria-label="説明"]', 1), count('section[aria-label="プロパティ"] button[aria-label="Project"]', 1)],
  },
  { name: "/my-issues", ready: [text("担当している Issue はありません")] },
  { name: "/views/1", ready: [count("table tbody tr", 8)] },
  { name: "/projects", ready: [count("table tbody tr", 4)] },
  { name: "/projects/1", ready: [count("table tbody tr", 3), count('section[aria-label="Milestones"]', 1)] },
  { name: "/initiatives", ready: [count("table tbody tr", 1)] },
  { name: "/cycles", ready: [text("Cycle はまだありません")] },
  { name: "/documents", ready: [count("table tbody tr", 3)] },
  { name: "/documents/new", ready: [count("select option", 3)] },
  { name: "/documents/1", ready: [count('section[aria-label="関連 Issue"] li', 1)] },
  { name: "/analytics", ready: [count('select[aria-label="Project"] option', 6), count('section[aria-label="週ごとの完了数"]', 1)] },
  { name: "/summary", ready: [count('select[aria-label="Project"] option', 6), count('section[aria-label="完了"]', 1)] },
  { name: "/workspaces/API/settings", ready: [count("h1", 1)] },
];

for (const route of ROUTES) {
  test(`${route.name} のシェルは Sidebar 244、項目 28、ヘッダー 44、Main の余白 8 と角丸 12`, async ({ page }) => {
    if (route.open) await route.open(page);
    else await page.goto(route.name);
    await expect(page.locator("main").locator(PAGE_HEADER).first()).toBeVisible();
    for (const ready of route.ready) await ready(page);
    const m = await measure(page);
    // PR に書く実測値
    console.log(`[shell] ${route.name} ${JSON.stringify(m)}`);
    expect(m.sidebarWidth).toBe(SIDEBAR_WIDTH);
    expect(m.navItemHeight).toBe(NAV_ITEM_HEIGHT);
    expect(m.headerHeight).toBe(HEADER_HEIGHT);
    expect(m.main).toEqual({ left: SIDEBAR_WIDTH, top: MAIN_MARGIN, right: MAIN_MARGIN, bottom: MAIN_MARGIN, radius: MAIN_RADIUS });
    // スクロールは Main のカードの内側で行い、ページ全体は縦にも横にも動かない
    expect(m.overflow.page).toBe(0);
    expect(m.overflow.pageY).toBe(0);
    // Main に横スクロールを出さない。Issue 詳細は #180、Analytics と Summary は #184 で直した（長い名前での検証は analytics と summary の spec にある）
    expect(m.overflow.main).toBe(0);
  });
}

test("View Bar は Header の下の高さ 43 の行で、タブは高さ 28 の円形", async ({ page }) => {
  await page.goto("/projects");
  const tabs = page.getByRole("tablist", { name: "Project の絞り込み" });
  const bar = await tabs.locator("..").boundingBox();
  expect(bar?.height).toBe(VIEW_BAR_HEIGHT);
  expect(bar?.y).toBe(MAIN_MARGIN + 1 + HEADER_HEIGHT); // Main の枠線 1 の内側で、Header のすぐ下
  for (const name of ["Active", "Completed"]) {
    const tab = tabs.getByRole("tab", { name });
    await expect(tab).toHaveCSS("height", "28px");
    await expect(tab).toHaveCSS("border-radius", PILL_RADIUS);
    await expect(tab).toHaveCSS("padding-left", "10px");
  }
});

test("Button は高さ 28（左右 12）と 24（左右 10）の円形", async ({ page }) => {
  await page.goto("/projects");
  const md = page.getByRole("button", { name: "New project" });
  await expect(md).toHaveCSS("height", "28px");
  await expect(md).toHaveCSS("padding-left", "12px");
  await expect(md).toHaveCSS("border-radius", PILL_RADIUS);

  // size="sm" は Milestone の行の「編集」で確かめる
  await page.goto("/projects/1");
  const milestones = page.getByRole("region", { name: "Milestones" });
  await milestones.getByRole("button", { name: "Milestone を追加" }).click();
  const form = milestones.getByRole("form", { name: "Milestone の追加" });
  await form.getByLabel("名前").fill("v1.0");
  await form.getByRole("button", { name: "保存" }).click();
  const sm = milestones.getByRole("button", { name: "v1.0 を編集" });
  await expect(sm).toHaveCSS("height", "24px");
  await expect(sm).toHaveCSS("padding-left", "10px");
  await expect(sm).toHaveCSS("border-radius", PILL_RADIUS);
});

test("Menu は角丸 12、MenuItem は高さ 32 と角丸 8", async ({ page }) => {
  await page.goto("/documents");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByRole("menu", { name: "種類で絞り込む" })).toHaveCSS("border-radius", "12px");
  const item = page.getByRole("menuitemradio", { name: "Plan" });
  await expect(item).toHaveCSS("height", "32px");
  await expect(item).toHaveCSS("border-radius", "8px");
});

// Header の操作が最も多い View（元に戻す、変更を保存、名前を変更、削除）で、プレビューを開いて一覧の幅を 440 減らす
const LONG_NAME = "仕事で今週中に片づける Issue をまとめた View（長い名前）";
for (const viewport of [{ width: 1440, height: 960 }, { width: 1280, height: 800 }]) {
  test.describe(`幅 ${viewport.width}px`, () => {
    test.use({ viewport });

    test("View の Header は操作が4つ並んでも高さ 44 のままで、画面名が読め、Main に横スクロールが出ない", async ({ page, nod }) => {
      await nod.me.updateView(1, { name: LONG_NAME });
      await page.goto("/views/1?preview=API-12");
      const rows = page.getByRole("table").locator("tbody tr");
      await expect(rows).toHaveCount(8);
      await expect(page.getByRole("complementary", { name: /プレビュー/ })).toBeVisible();
      await page.getByText("Filter", { exact: true }).click();
      await page.getByRole("group", { name: "Status" }).getByRole("checkbox", { name: "In Progress", exact: true }).check();
      for (const name of ["元に戻す", "変更を保存", "名前を変更", "削除"]) await expect(page.locator("main header").first().getByRole("button", { name })).toBeVisible();

      const title = page.getByRole("heading", { level: 1, name: LONG_NAME });
      await expect(title).toBeVisible();
      // 省略された画面名は title で読める
      await expect(title).toHaveAttribute("title", LONG_NAME);
      const m = await page.evaluate(() => {
        const main = document.querySelector("main") as HTMLElement;
        const header = main.querySelector("header") as HTMLElement;
        const h1 = header.querySelector("h1") as HTMLElement;
        return {
          headerWidth: header.getBoundingClientRect().width,
          headerHeight: header.getBoundingClientRect().height,
          headerOverflow: header.scrollWidth - header.clientWidth,
          titleWidth: Math.round(h1.getBoundingClientRect().width),
          mainOverflow: main.scrollWidth - main.clientWidth,
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
      console.log(`[shell] view header ${viewport.width} ${JSON.stringify(m)}`);
      expect(m.headerHeight).toBe(HEADER_HEIGHT);
      expect(m.headerOverflow).toBe(0);
      // 画面名は 4 文字分（4em = 52px）以上の幅を保つ
      expect(m.titleWidth).toBeGreaterThanOrEqual(52);
      expect(m.mainOverflow).toBe(0);
      expect(m.pageOverflow).toBe(0);
    });
  });
}

test("Analytics のカードは、題名を左端、凡例を右端に置く", async ({ page }) => {
  await page.goto("/analytics");
  const card = page.getByRole("region", { name: "週ごとの完了数", exact: true });
  const box = await card.boundingBox();
  const title = await card.getByRole("heading", { level: 2 }).boundingBox();
  const legend = await card.locator("span", { hasText: /^canceled$/ }).boundingBox();
  if (!box || !title || !legend) throw new Error("カードの題名か凡例がありません");
  // 凡例の右端はカードの右の余白（枠線 1 と padding 16）の位置にあり、題名とは離れている
  expect(Math.round(box.x + box.width - (legend.x + legend.width))).toBe(17);
  expect(legend.x - (title.x + title.width)).toBeGreaterThan(100);
});
