import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { measureSplitList } from "./layout-measure";

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

// #125: LLM が Triage を提案したら、購読していなくても me の通知タブに届く。人が確定すると既読になる
test("LLM の Triage 提案は通知タブに届き、人が受け入れると既読になる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.triageIssue("検索結果のページングがずれる");
  await nod.claude.proposeTriage(i.id, { decision: "accept", reason: "再現できた" });
  await page.goto("/inbox?tab=notifications");
  const row = list(page).getByRole("link", { name: /検索結果のページングがずれる（未読 1）/ });
  await expect(row).toContainText("claude-code が Triage を提案しました（受け入れ）");
  await nod.me.acceptTriage(i.id);
  await page.reload();
  await expect(list(page).getByRole("link", { name: /検索結果のページングがずれる/ })).toHaveCount(0);
  expect((await nod.me.listNotifications({ includeRead: true })).filter((n) => n.kind === "triage_proposal")).toMatchObject([{ readAt: expect.any(String) }]);
});

// #185：nod.pen の Inbox｜通知タブ（OzV0j）と Inbox｜スヌーズ中（H4XMf5）
test("通知の一覧も行は左右と上下に 8 の余白と角丸 8 で、題名は未読 500、既読 400。スヌーズ中の切り替えは Header と行の間に残る", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  const b = await api.startedIssue("決済 Webhook の再送処理");
  const c = await api.startedIssue("料金ページの比較表を更新");
  for (const issue of [a, b, c]) {
    await nod.me.subscribeIssue(issue.id);
    await nod.claude.commentIssue(issue.id, "検索結果は最大 50 件です");
  }
  await nod.me.markNotificationsRead({ issueRef: a.id });
  await nod.me.snoozeNotifications({ issueRef: c.id, until: new Date(Date.now() + 86_400_000).toISOString() });

  await page.goto("/inbox?tab=notifications");
  await expect(list(page).getByRole("link")).toHaveCount(2);
  await expect(list(page).getByRole("link", { name: /決済 Webhook の再送処理（未読 1）/ })).toBeVisible();
  await expect(detail(page).getByRole("heading", { level: 2 })).toBeVisible();
  const m = await measureSplitList(page, "通知の一覧");
  console.log(`[split] /inbox?tab=notifications ${JSON.stringify(m)}`);
  expect(m.listWidth).toBe(400);
  expect(m.headerHeight).toBe(44);
  expect(m.headerOverflow).toBe(0);
  expect(m.title).toBe("13px / 500");
  // 題名とタブ（確認依頼、通知と未読の数、すべて）だけが重ならずに並ぶ。件数は置かない
  expect(m.headerTexts).toEqual(["Inbox", "tabs"]);
  expect(m.headerParts).toBe(2);
  expect(m.headerGap).toBeGreaterThanOrEqual(8);
  expect(m.headerCenterDiff).toBeLessThanOrEqual(2.5);
  expect(m.headerRight).toBe(12);
  expect(m.tabHeights).toEqual([28]);
  expect(m.row).toEqual({ left: 8, right: 8, top: 8, bottom: 8, radius: "8px", padding: "12px", borderTop: "0px" });
  expect(m.selectedBackground).toBe("rgb(238, 240, 243)"); // --sunken
  expect(m.titleWeights).toEqual(["500"]);
  expect(m.readTitleWeights).toEqual(["400"]);
  // 切り替えの行は Header のすぐ下
  const header = await list(page).locator("header").boundingBox();
  const filter = await page.getByRole("tablist", { name: "通知の表示" }).locator("..").boundingBox();
  expect(filter?.y).toBe((header?.y ?? 0) + 44);

  await page.getByRole("tablist", { name: "通知の表示" }).getByRole("tab", { name: /スヌーズ中/ }).click();
  await expect(list(page).getByRole("link")).toHaveCount(1);
  await expect(list(page).getByRole("link")).toContainText("料金ページの比較表を更新");
  const snoozed = await measureSplitList(page, "通知の一覧");
  console.log(`[split] /inbox?tab=notifications&view=snoozed ${JSON.stringify(snoozed)}`);
  // 行の数と既読の行がないこと以外は、通知の一覧と同じ値になる
  expect(snoozed).toEqual({ ...m, rows: 1, readTitleWeights: [] });
});
