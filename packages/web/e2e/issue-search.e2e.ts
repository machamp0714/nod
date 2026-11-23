import type { Page } from "@playwright/test";
import { expect, test, waitForServerEvents } from "./fixtures";
import { restartApiServer } from "./support/nod";

// issue-list：API-13「workspace の取得をまとめる」はタイトルに workspace を含み、API-12 は説明にだけ含む。NOD-3 は done
test.use({ dataset: "issue-list" });

const dialog = (page: Page) => page.getByRole("dialog", { name: "Issue を検索" });
const box = (page: Page) => dialog(page).getByRole("combobox", { name: "Issue を検索" });
const options = (page: Page) => dialog(page).getByRole("option");

test.describe("Issue 検索", () => {
  test("どの画面でも Shift + Cmd + F で開き、ID とタイトルだけで探し、Enter で詳細を開く", async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.keyboard.press("Meta+Shift+F");
    await expect(box(page)).toBeFocused();

    // 説明にだけ含む API-12 は出さない
    await box(page).fill("workspace");
    await expect(options(page)).toHaveText([/API-13\s*workspace の取得をまとめる/]);

    // 完了した Issue も ID で探せる
    await box(page).fill("nod-3");
    await expect(options(page)).toHaveText([/NOD-3/]);
    await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
    await box(page).press("Enter");
    await expect(page).toHaveURL(/\/issues\/NOD-3$/);
    await expect(dialog(page)).toHaveCount(0);
  });

  test("矢印キーで選び、一致しないときはそう出し、Escape で閉じる", async ({ page }) => {
    await page.goto("/inbox");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.keyboard.press("Control+Shift+F");
    await box(page).fill("検索");
    await expect(options(page)).toHaveCount(2);
    await box(page).press("ArrowDown");
    await expect(options(page).nth(1)).toHaveAttribute("aria-selected", "true");
    const second = (await options(page).nth(1).textContent()) ?? "";
    await box(page).press("Enter");
    await expect(page).toHaveURL(new RegExp(`/issues/${second.match(/[A-Z]+-\d+/)![0]}$`));

    await page.getByRole("navigation", { name: "メイン" }).getByRole("button", { name: "検索" }).click();
    await box(page).fill("該当しない語");
    await expect(dialog(page).getByRole("status")).toHaveText("一致する Issue はありません");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
  });

  test("入力が問い合わせに届く前の Enter では、前の語の結果に移らない", async ({ page }) => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    await page.route(/\/api\/issues\?q=api-16$/, async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto("/inbox");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await waitForServerEvents(page);
    await page.keyboard.press("Meta+Shift+F");
    await box(page).fill("api-1");
    await expect(options(page).first()).toContainText("API-1");
    // デバウンス前と、問い合わせ後の初回取得中を別々に止める。
    // pauseAt 自体が時計を導入する。先に install すると停止までに時刻が進む。
    await page.clock.pauseAt(new Date());
    try {
      await box(page).press("6");
      await box(page).press("Enter");
      await expect(page).toHaveURL(/\/inbox$/);
      await expect(options(page)).not.toHaveText([/API-16/]);
      const requested = page.waitForRequest(/\/api\/issues\?q=api-16$/);
      await page.clock.runFor(200);
      await page.clock.resume();
      await requested;
      await expect(dialog(page).getByRole("status")).toHaveText("検索中…");
      await box(page).press("Enter");
      await expect(page).toHaveURL(/\/inbox$/);
    } finally {
      release();
      await page.clock.resume();
    }
    await expect(options(page)).toHaveText([/API-16/]);
    await box(page).press("Enter");
    await expect(page).toHaveURL(/\/issues\/API-16$/);
  });

  test("SSE による再取得中も、表示中の検索結果を Enter で開く", async ({ page, nod }) => {
    await restartApiServer();
    await page.goto("/inbox");
    await waitForServerEvents(page);
    await page.keyboard.press("Meta+Shift+F");
    await box(page).fill("api-16");
    await expect(options(page)).toHaveText([/API-16/]);

    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    await page.route(/\/api\/issues\?q=api-16$/, async (route) => {
      await gate;
      await route.continue();
    });
    // pauseAt 自体が時計を導入する。先に install すると停止までに時刻が進む。
    await page.clock.pauseAt(new Date());
    try {
      const requested = page.waitForRequest(/\/api\/issues\?q=api-16$/);
      await nod.me.updateIssue("API-13", { title: "workspace の取得を一括にする" });
      await requested;
      // Query の通知タイマーを進め、再取得開始を React に反映してから押す。
      await page.clock.runFor(1);
      await expect(options(page)).toHaveText([/API-16/]);
      await box(page).press("Enter");
      await expect(page).toHaveURL(/\/issues\/API-16$/);
    } finally {
      release();
      await page.clock.resume();
    }
  });

  test("Sidebar の検索ボタンから開いて Escape で閉じると、ボタンにフォーカスが戻る", async ({ page }) => {
    await page.goto("/inbox");
    const button = page.getByRole("navigation", { name: "メイン" }).getByRole("button", { name: "検索" });
    await button.click();
    await expect(box(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(button).toBeFocused();
  });
});
