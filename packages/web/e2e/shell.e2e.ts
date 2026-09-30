import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// シェルの寸法（#178）。design/nod.pen の Sidebar（mgInh）と各画面の Card に合わせる。
// 画面は playwright.config.ts の 1440×960 で開く
test.use({ dataset: "issue-list" });

const SIDEBAR_WIDTH = 244;
const NAV_ITEM_HEIGHT = 28;
const HEADER_HEIGHT = 44;
const MAIN_MARGIN = 8;
const MAIN_RADIUS = "12px";

async function measure(page: Page) {
  return page.evaluate(() => {
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
      headerHeight: rect(main?.querySelector("header") ?? null)?.height,
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
  });
}

const ROUTES: { name: string; open: (page: Page) => Promise<void> }[] = [
  { name: "/inbox", open: async (page) => void (await page.goto("/inbox")) },
  { name: "/issues", open: async (page) => void (await page.goto("/issues")) },
  {
    name: "/issues/<id>",
    open: async (page) => {
      await page.goto("/issues");
      await page.locator("main a[href^='/issues/']").first().click();
      await expect(page).toHaveURL(/\/issues\/[^/?]+$/);
    },
  },
  { name: "/projects", open: async (page) => void (await page.goto("/projects")) },
  { name: "/analytics", open: async (page) => void (await page.goto("/analytics")) },
  { name: "/summary", open: async (page) => void (await page.goto("/summary")) },
  { name: "/workspaces/API/settings", open: async (page) => void (await page.goto("/workspaces/API/settings")) },
];

for (const route of ROUTES) {
  test(`${route.name} のシェルは Sidebar 244、項目 28、ヘッダー 44、Main の余白 8 と角丸 12`, async ({ page }) => {
    await route.open(page);
    await expect(page.locator("main header").first()).toBeVisible();
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
    // このデータセットでは、Issue 詳細と Analytics と Summary の既知のはみ出し（#180、#184）は出ない
    expect(m.overflow.main).toBe(0);
  });
}
