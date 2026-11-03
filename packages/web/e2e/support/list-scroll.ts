import { expect, type Locator, type Page, type Route } from "@playwright/test";

// Issue 一覧のスクロール復元（NOD-52）の観測。Issues・View・Sprint 詳細のテストで共通に使う。
// スクロール領域は data-scroll-region で区別する（main、表は table:…、Board は board / board:…）

export interface RegionScroll {
  x: number;
  y: number;
  maxX: number; // 到達できる最大の座標（scrollWidth - clientWidth）
  maxY: number;
}

// 今ある全スクロール領域の位置と到達範囲
export async function scrollRegions(page: Page): Promise<Record<string, RegionScroll>> {
  return page.evaluate(() => {
    const main = document.querySelector("main") as HTMLElement;
    const regions = [main, ...main.querySelectorAll<HTMLElement>("[data-scroll-region]")];
    return Object.fromEntries(
      regions.map((el) => [
        el.dataset.scrollRegion ?? "main",
        { x: el.scrollLeft, y: el.scrollTop, maxX: el.scrollWidth - el.clientWidth, maxY: el.scrollHeight - el.clientHeight },
      ]),
    );
  });
}

// 座標だけを取り出す（期待値との比較用）
export function positions(regions: Record<string, RegionScroll>): Record<string, { x: number; y: number }> {
  return Object.fromEntries(Object.entries(regions).map(([key, r]) => [key, { x: Math.round(r.x), y: Math.round(r.y) }]));
}

// テストの準備として領域を動かす（利用者の入力にはしない）。動かした後の実測値を返す
export async function scrollRegion(page: Page, region: string, to: { x?: number; y?: number }): Promise<RegionScroll> {
  return page.evaluate(([key, point]) => {
    const main = document.querySelector("main") as HTMLElement;
    const el = key === "main" ? main : main.querySelector<HTMLElement>(`[data-scroll-region="${CSS.escape(key)}"]`);
    if (!el) throw new Error(`スクロール領域 ${key} がありません`);
    if (point.x !== undefined) el.scrollLeft = point.x;
    if (point.y !== undefined) el.scrollTop = point.y;
    return { x: el.scrollLeft, y: el.scrollTop, maxX: el.scrollWidth - el.clientWidth, maxY: el.scrollHeight - el.clientHeight };
  }, [region, to] as const);
}

// 期待する座標になるまで待つ（固定の sleep ではなく、位置を繰り返し測る）
export async function expectPositions(page: Page, expected: Record<string, { x: number; y: number }>): Promise<void> {
  await expect.poll(async () => {
    const now = positions(await scrollRegions(page));
    return Object.fromEntries(Object.keys(expected).map((key) => [key, now[key] ?? null]));
  }).toEqual(expected);
}

// 一覧の行・カードのうち、どのスクロール領域でも切れずに見えている詳細へのリンク。押してもスクロールが起きない
export async function visibleIssueLink(page: Page, scope = "main"): Promise<Locator> {
  const href = await page.evaluate((selector) => {
    const root = document.querySelector(selector) as HTMLElement;
    const links = [...root.querySelectorAll<HTMLAnchorElement>('[data-issue-row] a[href^="/issues/"], article a[href^="/issues/"]')];
    const inside = (el: Element) => {
      const r = el.getBoundingClientRect();
      for (let box: Element | null = el.parentElement; box; box = box.parentElement) {
        const style = getComputedStyle(box);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const b = box.getBoundingClientRect();
        if (r.left < b.left || r.right > b.right || r.top < b.top || r.bottom > b.bottom) return false;
      }
      return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
    };
    // 中ほどのリンクを選ぶ（端のリンクは位置の差が出にくい）
    const shown = links.filter(inside);
    return shown[Math.floor(shown.length / 2)]?.getAttribute("href") ?? null;
  }, scope);
  if (!href) throw new Error("切れずに見えている Issue のリンクがありません");
  return page.locator(`${scope} a[href="${href}"]`).first();
}

// 詳細を開く。押す直前の各領域の実測値を返す（戻った後の期待値）
export async function openDetailFrom(page: Page, link: Locator): Promise<Record<string, { x: number; y: number }>> {
  await expect(link).toBeInViewport({ ratio: 1 });
  const before = positions(await scrollRegions(page));
  // 行に乗るとプレビューのボタンが出て題名の幅が変わるため、題名の左端を押す（押す位置がずれて自動でスクロールしないように）
  const box = (await link.boundingBox())!;
  await link.click({ position: { x: 2, y: box.height / 2 } });
  await expect(page).toHaveURL(/\/issues\/[A-Z]+-\d+$/);
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  return before;
}

// 応答を止めておき、release で順に流す。fulfill を渡すと、その内容で返す
export async function holdRequests(page: Page, url: RegExp) {
  const held: Route[] = [];
  let holding = true;
  const handler = async (route: Route) => {
    if (holding) held.push(route);
    else await route.continue();
  };
  await page.route(url, handler);
  return {
    count: () => held.length,
    async release(respond?: (route: Route) => Promise<void>) {
      holding = false;
      for (const route of held.splice(0)) await (respond ? respond(route) : route.continue());
      await page.unroute(url, handler);
    },
  };
}

// すべてのスクロール領域（main・表・Board）のスクロールアンカーを止める。各ファイルの beforeEach で、ページを開く前に呼ぶ。
// 行が伸びた分をブラウザのスクロールアンカーが補正すると、復元が目標を当て直さなくても元の位置に見える。
// Desktop の WKWebView にはスクロールアンカーがないため、止めた状態で当て直しを確かめる
export async function disableScrollAnchoring(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const add = () => {
      const style = document.createElement("style");
      style.textContent = "[data-scroll-region] { overflow-anchor: none !important; }";
      document.documentElement.appendChild(style);
    };
    if (document.documentElement) add();
    else document.addEventListener("DOMContentLoaded", add, { once: true });
  });
}
