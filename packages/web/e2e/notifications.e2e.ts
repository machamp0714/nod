import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";

const tabs = (page: Page) => page.getByRole("tablist", { name: "Inboxの表示" });
const list = (page: Page) => page.getByRole("region", { name: "通知の一覧" });
const detail = (page: Page) => page.getByRole("region", { name: "詳細", exact: true });
const timeline = (page: Page) => detail(page).getByRole("region", { name: "通知" });

test("Issue 詳細で購読すると、LLM の変化が Inbox の通知タブに届き、開くと既読になる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  const b = await api.startedIssue("決済 Webhook の再送処理");

  await page.goto(`/issues/${a.id}`);
  const toggle = page.getByRole("button", { name: "購読する" });
  await toggle.click();
  await expect(page.getByRole("button", { name: "購読中" })).toHaveAttribute("aria-pressed", "true");
  expect((await nod.me.getIssue(a.id)).subscribed).toBe(true);
  await nod.me.subscribeIssue(b.id);

  // 自分の操作は届かない。LLM のコメントと状態の変化は届く
  await nod.me.commentIssue(a.id, "自分のメモ");
  await nod.claude.commentIssue(a.id, "検索結果は最大 50 件です");
  await nod.claude.completeIssue(b.id, { summary: "直した" });

  await page.goto("/inbox?tab=notifications");
  await expect(tabs(page).getByRole("tab", { name: /通知/ })).toHaveAttribute("aria-selected", "true");
  await expect(tabs(page).getByRole("tab", { name: /通知/ })).toContainText("3");
  await expect(list(page).getByRole("link")).toHaveCount(2);
  const rowA = list(page).getByRole("link", { name: /検索 API の N\+1 を解消（未読 1）/ });
  await expect(rowA).toContainText("claude-code がコメントしました");
  await expect(list(page).getByRole("link", { name: /決済 Webhook の再送処理（未読 2）/ })).toContainText("ほか 1 件");

  // 先頭（最新）の Issue は表示するだけでは既読にしない。一覧で開くと既読になる
  await rowA.click();
  await expect(page).toHaveURL(new RegExp(`selected=${a.id}`));
  await expect(detail(page).getByRole("heading", { level: 2, name: "検索 API の N+1 を解消" })).toBeVisible();
  await expect(timeline(page).getByText("claude-code がコメントしました：「検索結果は最大 50 件です」")).toBeVisible();
  await expect(timeline(page).getByText("自分のメモ")).toHaveCount(0);
  await expect(tabs(page).getByRole("tab", { name: /通知/ })).toContainText("2");
  expect((await nod.me.listNotifications({})).map((n) => n.issueId)).toEqual([b.id, b.id]);
  await expect(detail(page).getByRole("button", { name: "既読にする" })).toBeDisabled();

  // すべて既読と購読の解除
  await detail(page).getByRole("button", { name: "すべて既読" }).click();
  await expect(tabs(page).getByRole("tab", { name: /通知/ })).not.toContainText(/\d/);
  expect(await nod.me.listNotifications({})).toEqual([]);
  await detail(page).getByRole("button", { name: "購読を解除" }).click();
  await expect(detail(page).getByRole("button", { name: "購読する" })).toBeVisible();
  expect((await nod.me.getIssue(a.id)).subscribed).toBe(false);

  // URL の tab と selected は再読み込みでも保たれ、既存の確認依頼タブは変わらない
  await page.reload();
  await expect(detail(page).getByRole("heading", { level: 2, name: "検索 API の N+1 を解消" })).toBeVisible();
  await tabs(page).getByRole("tab", { name: /確認依頼/ }).click();
  await expect(page.getByRole("region", { name: "確認依頼の一覧" }).getByText("確認依頼はありません")).toBeVisible();
});

test("購読した Issue がないときは通知タブに案内を出す", async ({ page, nod }) => {
  await seedApiWorkspace(nod);
  await page.goto("/inbox?tab=notifications");
  await expect(list(page).getByText("通知はありません。Issue を購読すると、変化がここに届きます")).toBeVisible();
});
