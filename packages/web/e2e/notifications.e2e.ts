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

  // 自分の操作は届かない。LLM のコメントと完了は届く（完了の報告とステータスの変化は完了の1件にまとまる）
  await nod.me.commentIssue(a.id, "自分のメモ");
  await nod.claude.commentIssue(a.id, "検索結果は最大 50 件です");
  await nod.claude.completeIssue(b.id, { summary: "直した" });

  await page.goto("/inbox?tab=notifications");
  await expect(tabs(page).getByRole("tab", { name: /通知/ })).toHaveAttribute("aria-selected", "true");
  await expect(tabs(page).getByRole("tab", { name: /通知/ })).toContainText("2");
  await expect(list(page).getByRole("link")).toHaveCount(2);
  const rowA = list(page).getByRole("link", { name: /検索 API の N\+1 を解消（未読 1）/ });
  await expect(rowA).toContainText("claude-code がコメントしました");
  await expect(list(page).getByRole("link", { name: /決済 Webhook の再送処理（未読 1）/ })).toContainText("claude-code が作業を完了しました（レビュー待ち）");

  // 先頭（最新）の Issue は表示するだけでは既読にしない。一覧で開くと既読になる
  await rowA.click();
  await expect(page).toHaveURL(new RegExp(`selected=${a.id}`));
  await expect(detail(page).getByRole("heading", { level: 2, name: "検索 API の N+1 を解消" })).toBeVisible();
  await expect(timeline(page).getByText("claude-code がコメントしました：「検索結果は最大 50 件です」")).toBeVisible();
  await expect(timeline(page).getByText("自分のメモ")).toHaveCount(0);
  await expect(tabs(page).getByRole("tab", { name: /通知/ })).toContainText("1");
  expect((await nod.me.listNotifications({})).map((n) => n.issueId)).toEqual([b.id]);
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
  await expect(list(page).getByText("通知はありません。Issue を購読すると変化が、LLM に任せた Issue は完了・入力待ち・エラーがここに届きます")).toBeVisible();
});

test("開いている Issue に新しい通知が届いたら、それも既読にして未読の欄に出す", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  await nod.me.subscribeIssue(a.id);
  const root = await nod.claude.commentIssue(a.id, "最初のコメント");

  await page.goto("/inbox?tab=notifications");
  await list(page).getByRole("link", { name: /検索 API の N\+1 を解消（未読 1）/ }).click();
  await expect(page).toHaveURL(new RegExp(`selected=${a.id}`));
  await expect.poll(async () => (await nod.me.listNotifications({})).length).toBe(0);

  // 開いたままの間に届いた通知も既読になり、画面では未読の欄に並ぶ
  await nod.claude.commentIssue(a.id, "スレッドへの返信", { replyTo: root.id });
  await expect(timeline(page).getByText("claude-code がコメントしました：「スレッドへの返信」")).toBeVisible();
  await expect.poll(async () => (await nod.me.listNotifications({})).length).toBe(0);
  await expect(timeline(page).getByRole("heading", { name: "未読 2" })).toBeVisible();
  await expect(tabs(page).getByRole("tab", { name: /通知/ })).not.toContainText(/\d/);
});

test("購読していなくても、LLM に任せた Issue の入力待ち・エラー・完了が届き、回答すると既読になる（#54）", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  const b = await api.startedIssue("決済 Webhook の再送処理");
  await nod.claude.askQuestion(a.id, "IN 句の上限は 50 件でよいか");
  await nod.claude.failIssue(b.id, "DB に接続できない");

  await page.goto("/inbox?tab=notifications");
  await expect(tabs(page).getByRole("tab", { name: /通知/ })).toContainText("2");
  const rowA = list(page).getByRole("link", { name: /検索 API の N\+1 を解消（未読 1）/ });
  await expect(rowA).toContainText("claude-code が確認を求めました（入力待ち）");
  await expect(list(page).getByRole("link", { name: /決済 Webhook の再送処理（未読 1）/ })).toContainText("claude-code がエラーで止まりました（エラー）");
  // 確認依頼タブにも質問は残る
  await expect(tabs(page).getByRole("tab", { name: /確認依頼/ })).toContainText("1");

  await list(page).getByRole("link", { name: /決済 Webhook の再送処理/ }).click();
  await expect(timeline(page).getByText("claude-code がエラーで止まりました（エラー）：「DB に接続できない」")).toBeVisible();

  // 確認依頼に回答すると、その Issue の LLM の通知は既読になる
  await nod.me.answerQuestion(a.id, "50 件でよい");
  await expect.poll(async () => (await nod.me.listNotifications({})).map((n) => n.issueId)).toEqual([]);
  await nod.claude.completeIssue(a.id, { summary: "直した" });
  await page.reload();
  await expect(list(page).getByRole("link", { name: /検索 API の N\+1 を解消（未読 1）/ })).toContainText("claude-code が作業を完了しました（レビュー待ち）");
});
