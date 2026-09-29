import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";

const tabs = (page: Page) => page.getByRole("tablist", { name: "Inboxの表示" });
const filter = (page: Page) => page.getByRole("tablist", { name: "通知の表示" });
const list = (page: Page) => page.getByRole("region", { name: "通知の一覧" });
const detail = (page: Page) => page.getByRole("region", { name: "詳細", exact: true });
const timeline = (page: Page) => detail(page).getByRole("region", { name: "通知" });
const menu = (page: Page) => page.getByRole("menu", { name: "スヌーズの期限" });

const tomorrowAt9 = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9).toISOString();
};

test("通知を Issue ごとにスヌーズすると一覧から消え、スヌーズ中に期限付きで出て、解除すると戻る（#43）", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  const b = await api.startedIssue("決済 Webhook の再送処理");
  await nod.me.subscribeIssue(a.id);
  await nod.me.subscribeIssue(b.id);
  await nod.claude.commentIssue(a.id, "a1");
  await nod.claude.commentIssue(b.id, "b1");

  await page.goto(`/inbox?tab=notifications&selected=${a.id}`);
  await expect(detail(page).getByRole("heading", { level: 2, name: "検索 API の N+1 を解消" })).toBeVisible();
  await detail(page).getByRole("button", { name: "スヌーズ" }).click();
  await expect(menu(page).getByRole("menuitem")).toHaveText([/1時間後/, /明日 9:00/, /来週月曜 9:00/, /日時指定…/]);
  await menu(page).getByRole("menuitem", { name: /明日 9:00/ }).click();

  await expect(list(page).getByRole("link", { name: /検索 API の N\+1 を解消/ })).toHaveCount(0);
  await expect(filter(page).getByRole("tab", { name: /スヌーズ中/ })).toContainText("1");
  const snoozed = await nod.me.listNotifications({ snoozed: true });
  expect(snoozed.map((n) => [n.issueId, n.snoozedUntil])).toEqual([[a.id, tomorrowAt9()]]);

  // スヌーズ中の表示は URL で保たれ、開いても既読にしない
  await filter(page).getByRole("tab", { name: /スヌーズ中/ }).click();
  await expect(page).toHaveURL(/view=snoozed/);
  const row = list(page).getByRole("link", { name: /検索 API の N\+1 を解消/ });
  await expect(row).toContainText("明日 9:00 まで");
  await row.click();
  await page.reload();
  await expect(detail(page).getByText("明日 9:00 までスヌーズ中")).toBeVisible();
  expect((await nod.me.listNotifications({ snoozed: true }))[0]!.readAt).toBeNull();

  await detail(page).getByRole("button", { name: "スヌーズを解除" }).click();
  await expect(list(page).getByText("スヌーズ中の通知はありません")).toBeVisible();
  await filter(page).getByRole("tab", { name: "すべて" }).click();
  await expect(list(page).getByRole("link", { name: /検索 API の N\+1 を解消（未読 1）/ })).toBeVisible();
  await expect(tabs(page).getByRole("tab", { name: /通知/ })).toContainText("2");
});

test("日時指定でスヌーズでき、スヌーズ中に新着が届くと一緒に再表示される（#43）", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  await nod.me.subscribeIssue(a.id);
  await nod.claude.commentIssue(a.id, "a1");

  await page.goto(`/inbox?tab=notifications&selected=${a.id}`);
  await detail(page).getByRole("button", { name: "スヌーズ" }).click();
  await menu(page).getByRole("menuitem", { name: /日時指定…/ }).click();
  const submit = menu(page).getByRole("button", { name: "スヌーズする" });
  await expect(submit).toBeDisabled();
  const d = new Date();
  const later = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 2, 14);
  const ymd = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, "0")}-${String(later.getDate()).padStart(2, "0")}`;
  await menu(page).getByLabel("スヌーズの日付").fill(ymd);
  await menu(page).getByLabel("スヌーズの時刻").fill("14:00");
  await submit.click();
  await expect(menu(page)).toHaveCount(0);
  expect((await nod.me.listNotifications({ snoozed: true })).map((n) => n.snoozedUntil)).toEqual([later.toISOString()]);
  await expect(list(page).getByText("通知はありません。Issue を購読すると変化が、LLM に任せた Issue は完了・入力待ち・エラーがここに届きます")).toBeVisible();

  await nod.claude.commentIssue(a.id, "a2");
  await expect(list(page).getByRole("link", { name: /検索 API の N\+1 を解消/ })).toBeVisible();
  await expect(filter(page).getByRole("tab", { name: /スヌーズ中/ })).toContainText("0");
});

test("通知を削除すると一覧から消え、元に戻すと戻り、削除後の新着は新しい通知として出る（#44）", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  await nod.me.subscribeIssue(a.id);
  await nod.claude.commentIssue(a.id, "古いコメント");

  await page.goto(`/inbox?tab=notifications&selected=${a.id}`);
  await detail(page).getByRole("button", { name: "削除" }).click();
  const toast = page.getByRole("status").filter({ hasText: "通知を削除しました" });
  await expect(toast).toBeVisible();
  await expect(list(page).getByRole("link")).toHaveCount(0);
  expect(await nod.me.listNotifications({ includeRead: true })).toEqual([]);

  await toast.getByRole("button", { name: "元に戻す" }).click();
  await expect(toast).toHaveCount(0);
  await expect(list(page).getByRole("link", { name: /検索 API の N\+1 を解消/ })).toBeVisible();
  expect(await nod.me.listNotifications({ includeRead: true })).toHaveLength(1);

  // 削除したものは戻さず、後から届いた通知だけを出す
  await list(page).getByRole("link", { name: /検索 API の N\+1 を解消/ }).click();
  await detail(page).getByRole("button", { name: "削除" }).click();
  await expect(list(page).getByRole("link")).toHaveCount(0);
  await nod.claude.commentIssue(a.id, "新しいコメント");
  await list(page).getByRole("link", { name: /検索 API の N\+1 を解消（未読 1）/ }).click();
  await expect(timeline(page).getByText("claude-code がコメントしました：「新しいコメント」")).toBeVisible();
  await expect(timeline(page).getByText(/古いコメント/)).toHaveCount(0);
});

test("スヌーズ中の通知も削除できる（#43/#44）", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  await nod.me.subscribeIssue(a.id);
  await nod.claude.commentIssue(a.id, "a1");
  await nod.me.snoozeNotifications({ issueRef: a.id, until: "2999-01-01T00:00:00.000Z" });

  await page.goto("/inbox?tab=notifications&view=snoozed");
  await expect(list(page).getByRole("link", { name: /検索 API の N\+1 を解消/ })).toBeVisible();
  await detail(page).getByRole("button", { name: "削除" }).click();
  await expect(list(page).getByText("スヌーズ中の通知はありません")).toBeVisible();
  expect(await nod.me.listNotifications({ snoozed: true })).toEqual([]);
});

test("スヌーズの期限が来ると、読み込み直さなくても一覧に未読1件で戻る（#43）", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  await nod.me.subscribeIssue(a.id);
  await nod.claude.commentIssue(a.id, "a1");
  await nod.claude.commentIssue(a.id, "a2");
  await nod.me.snoozeNotifications({ issueRef: a.id, until: new Date(Date.now() + 3000).toISOString() });

  await page.goto("/inbox?tab=notifications");
  await expect(list(page).getByRole("link", { name: /検索 API の N\+1 を解消/ })).toHaveCount(0);
  await expect(list(page).getByRole("link", { name: /検索 API の N\+1 を解消（未読 1）/ })).toBeVisible({ timeout: 10_000 });
  await expect(filter(page).getByRole("tab", { name: /スヌーズ中/ })).toContainText("0");
});

test("トーストを出している間に続けて削除すると、元に戻すのは直近の削除（#44）", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  const b = await api.startedIssue("決済 Webhook の再送処理");
  await nod.me.subscribeIssue(a.id);
  await nod.me.subscribeIssue(b.id);
  await nod.claude.commentIssue(a.id, "a1");
  await nod.claude.commentIssue(b.id, "b1");

  await page.goto(`/inbox?tab=notifications&selected=${a.id}`);
  await detail(page).getByRole("button", { name: "削除" }).click();
  const toast = page.getByRole("status").filter({ hasText: "通知を削除しました" });
  await expect(toast).toBeVisible();
  await list(page).getByRole("link", { name: /決済 Webhook の再送処理/ }).click();
  await detail(page).getByRole("button", { name: "削除" }).click();
  await expect(list(page).getByRole("link")).toHaveCount(0);

  await toast.getByRole("button", { name: "元に戻す" }).click();
  await expect(toast).toHaveCount(0);
  await expect(list(page).getByRole("link", { name: /決済 Webhook の再送処理/ })).toBeVisible();
  await expect(list(page).getByRole("link", { name: /検索 API の N\+1 を解消/ })).toHaveCount(0);
});

// 削除のあとに提案の置き換え・取り下げで消えた通知は戻せない（#134）。戻せなかった件数をトーストに示す
for (const [updated, missing] of [[0, 2], [1, 1]] as const) {
  test(`元に戻すときに消えた通知があれば、その件数を示す（戻した ${updated} 件・消えた ${missing} 件、#134）`, async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const a = await api.startedIssue("検索 API の N+1 を解消");
    await nod.me.subscribeIssue(a.id);
    await nod.claude.commentIssue(a.id, "a1");

    await page.goto(`/inbox?tab=notifications&selected=${a.id}`);
    await detail(page).getByRole("button", { name: "削除" }).click();
    const toast = page.getByRole("status").filter({ hasText: /通知を削除しました|戻せませんでした/ });
    await expect(toast).toContainText("通知を削除しました");
    await page.route("**/api/notifications/restore", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ updated, missing }) }));
    await toast.getByRole("button", { name: "元に戻す" }).click();
    await expect(toast).toHaveText(`${missing}件はもう無いため戻せませんでした`);
    await expect(toast.getByRole("button", { name: "元に戻す" })).toHaveCount(0);
    await expect(toast).toHaveCount(0, { timeout: 10_000 });
  });
}

test.describe("取り消しの失敗", () => {
  test.use({ allowedConsoleErrors: [/Failed to load resource.*status of 500/] });

  test("元に戻すのに失敗したら、トーストの中に理由を出す（#44）", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const a = await api.startedIssue("検索 API の N+1 を解消");
    await nod.me.subscribeIssue(a.id);
    await nod.claude.commentIssue(a.id, "a1");

    await page.goto(`/inbox?tab=notifications&selected=${a.id}`);
    await detail(page).getByRole("button", { name: "削除" }).click();
    const toast = page.getByRole("status").filter({ has: page.getByRole("button", { name: "元に戻す" }) });
    await expect(toast).toContainText("通知を削除しました");
    await page.route("**/api/notifications/restore", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "DB_BUSY", message: "取り消しの保存失敗" } }) }));
    await toast.getByRole("button", { name: "元に戻す" }).click();
    await expect(toast.getByRole("alert")).toContainText("元に戻せませんでした（取り消しの保存失敗）");
    await expect(list(page).getByRole("link")).toHaveCount(0);

    await page.unroute("**/api/notifications/restore");
    await toast.getByRole("button", { name: "元に戻す" }).click();
    await expect(toast).toHaveCount(0);
    await expect(list(page).getByRole("link", { name: /検索 API の N\+1 を解消/ })).toBeVisible();
  });
});
