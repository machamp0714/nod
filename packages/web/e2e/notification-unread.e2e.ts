import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";

const tabs = (page: Page) => page.getByRole("tablist", { name: "Inboxの表示" });
const list = (page: Page) => page.getByRole("region", { name: "通知の一覧" });
const detail = (page: Page) => page.getByRole("region", { name: "詳細", exact: true });
const badge = (page: Page) => tabs(page).getByRole("tab", { name: /通知/ });
const unreadButton = (page: Page) => detail(page).getByRole("button", { name: "未読に戻す" });

// #161: 既読にした通知を Inbox から未読に戻す（Pencil『Inbox｜未読に戻す』）
async function seed(nod: Parameters<typeof seedApiWorkspace>[0]) {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  const b = await api.startedIssue("決済 Webhook の再送処理");
  await nod.me.subscribeIssue(a.id);
  await nod.me.subscribeIssue(b.id);
  await nod.claude.commentIssue(a.id, "最初のコメント");
  await nod.claude.commentIssue(a.id, "二つ目のコメント");
  // b を新しくして、a が一覧の先頭（選ばなくても詳細に出る行）にならないようにする。同じ時刻だと並びが ID 順になるので少し待つ
  await new Promise((resolve) => setTimeout(resolve, 5));
  await nod.claude.commentIssue(b.id, "別の Issue のコメント");
  return { a, b };
}

test("開いて既読になった通知を未読に戻すと、選択が外れて最新の1件が未読に戻り、開き直すとまた既読になる", async ({ page, nod }) => {
  const { a, b } = await seed(nod);
  await page.goto("/inbox?tab=notifications");
  // 先頭の Issue は表示しているだけで未読のまま。最新の通知が未読なので、戻すものがない
  await expect(detail(page).getByRole("heading", { level: 2, name: "決済 Webhook の再送処理" })).toBeVisible();
  await expect(unreadButton(page)).toBeDisabled();

  await list(page).getByRole("link", { name: /検索 API の N\+1 を解消（未読 2）/ }).click();
  await expect(page).toHaveURL(new RegExp(`selected=${a.id}`));
  await expect.poll(async () => (await nod.me.listNotifications({})).map((n) => n.issueId)).toEqual([b.id]);
  await expect(badge(page)).toContainText("1");

  await expect(unreadButton(page)).toBeEnabled();
  await unreadButton(page).click();
  await expect(page).not.toHaveURL(/selected=/);
  await expect(list(page).getByRole("link", { name: /検索 API の N\+1 を解消（未読 1）/ })).toBeVisible();
  await expect(badge(page)).toContainText("2");
  await expect(page.getByRole("alert")).toHaveCount(0);
  const unread = await nod.me.listNotifications({});
  expect(unread.filter((n) => n.issueId === a.id).map((n) => n.body)).toEqual(["二つ目のコメント"]);

  // 再読み込みしても未読のまま（開いていないので既読に戻らない）
  await page.reload();
  const rowA = list(page).getByRole("link", { name: /検索 API の N\+1 を解消（未読 1）/ });
  await expect(rowA).toBeVisible();
  expect((await nod.me.listNotifications({})).length).toBe(2);

  // 一覧で開き直すと、また既読になる
  await rowA.click();
  await expect.poll(async () => (await nod.me.listNotifications({})).map((n) => n.issueId)).toEqual([b.id]);
  await expect(unreadButton(page)).toBeEnabled();
});

test("一覧の先頭の Issue を未読に戻しても、詳細に出たまま既読に戻らず、開き直すと既読になる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  await nod.me.subscribeIssue(a.id);
  await nod.claude.commentIssue(a.id, "最初のコメント");
  await page.goto("/inbox?tab=notifications");
  const row = () => list(page).getByRole("link", { name: /検索 API の N\+1 を解消/ });
  await row().click();
  await expect.poll(async () => (await nod.me.listNotifications({})).length).toBe(0);

  await unreadButton(page).click();
  await expect(page).not.toHaveURL(/selected=/);
  await expect(list(page).getByRole("link", { name: /検索 API の N\+1 を解消（未読 1）/ })).toBeVisible();
  // 先頭なので詳細には出たままだが、開いていないので既読にしない
  await expect(detail(page).getByRole("heading", { level: 2, name: "検索 API の N+1 を解消" })).toBeVisible();
  await expect(unreadButton(page)).toBeDisabled();
  await page.waitForTimeout(500);
  expect(await nod.me.listNotifications({})).toHaveLength(1);

  await row().click();
  await expect.poll(async () => (await nod.me.listNotifications({})).length).toBe(0);
});

test.describe("未読に戻す失敗", () => {
  test.use({ allowedConsoleErrors: [/Failed to load resource.*status of 500/] });

  test("未読に戻すのに失敗したら理由を出し、選択も既読も変えない。スヌーズ中の表示には出さない", async ({ page, nod }) => {
    const { a } = await seed(nod);
    await nod.me.markNotificationsRead({ all: true });
    await page.goto(`/inbox?tab=notifications&selected=${a.id}`);
    await expect(unreadButton(page)).toBeEnabled();

    await page.route("**/api/notifications/unread", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "DB_BUSY", message: "未読に戻す保存失敗" } }) }));
    await unreadButton(page).click();
    await expect(detail(page).getByRole("alert")).toContainText("未読に戻す保存失敗");
    await expect(page).toHaveURL(new RegExp(`selected=${a.id}`));
    expect(await nod.me.listNotifications({})).toEqual([]);

    await page.unroute("**/api/notifications/unread");
    await unreadButton(page).click();
    await expect(page).not.toHaveURL(/selected=/);
    await expect(detail(page).getByRole("alert")).toHaveCount(0);
    expect((await nod.me.listNotifications({})).map((n) => n.body)).toEqual(["二つ目のコメント"]);

    await nod.me.snoozeNotifications({ issueRef: a.id, until: "2999-01-01T00:00:00.000Z" });
    await page.goto(`/inbox?tab=notifications&view=snoozed&selected=${a.id}`);
    await expect(detail(page).getByRole("button", { name: "スヌーズを解除" })).toBeVisible();
    await expect(unreadButton(page)).toHaveCount(0);
  });
});
