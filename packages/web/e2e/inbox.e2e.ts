import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test, waitForServerEvents } from "./fixtures";
import { measureSplitList } from "./layout-measure";

const list = (page: Page) => page.getByRole("region", { name: "確認依頼の一覧" });
const detail = (page: Page) => page.getByRole("region", { name: "詳細", exact: true });
const asks = (page: Page) => detail(page).getByRole("region", { name: "確認依頼", exact: true });

test("LLM の確認依頼を Issue ごとに新しい順に並べ、実行場所を出し、私の未決事項は出さない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  await api.ask(a.id, "複合インデックスにしてよいですか？");
  await api.ask(a.id, "私が残した未決事項", nod.me);
  const b = await api.startedIssue("決済 Webhook の再送処理", nod.codex);
  await api.ask(b.id, "リトライ上限を 5 回にしてよいですか？", nod.codex);

  await page.goto("/inbox");
  await expect(list(page).getByRole("link")).toHaveCount(2);
  await expect(list(page).getByRole("link").first()).toContainText("決済 Webhook の再送処理");
  await expect(detail(page).getByRole("heading", { level: 2, name: "決済 Webhook の再送処理" })).toBeVisible();
  const location = detail(page).getByText("実行場所：api-server / main");
  await expect(location).toBeVisible();
  await expect(location).toHaveAttribute("title", api.repo);

  await list(page).getByRole("link", { name: /検索 API の N\+1 を解消/ }).click();
  await expect(page).toHaveURL(new RegExp(`selected=${a.id}`));
  await expect(asks(page)).toHaveCount(1);
  await expect(asks(page).getByText("複合インデックスにしてよいですか？")).toBeVisible();
  await expect(asks(page).getByText("私が残した未決事項")).toHaveCount(0);
});

test("Inbox で回答すると DB に記録され、一覧から消える", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  await api.ask(a.id, "既存のインデックスは消してよいですか？");

  await page.goto("/inbox");
  await expect(asks(page).getByRole("button", { name: "回答する" })).toBeDisabled();
  await asks(page).getByRole("textbox", { name: "回答" }).fill("消してよい");
  await asks(page).getByRole("button", { name: "回答する" }).click();

  await expect(list(page).getByText("確認依頼はありません")).toBeVisible();
  const shown = await api.show(a.id);
  expect(shown.questions).toMatchObject([{ question: "既存のインデックスは消してよいですか？", answer: "消してよい", answeredBy: "me" }]);
  expect(shown.agentState).toBe("working");
  await expect(page.getByRole("navigation", { name: "メイン" }).getByRole("link", { name: /^Inbox/ })).toContainText("0");
});

test("別の端末で nod issue ask を実行すると、約1秒で Inbox と Sidebar に出る", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  await page.goto("/inbox");
  await waitForServerEvents(page);
  await expect(list(page).getByText("確認依頼はありません")).toBeVisible();

  // データの口は server とは別の接続で書くため、nod を実行したときと同じく SSE の change が届く（H の決定）
  await api.ask(a.id, "複合インデックスにしてよいですか？");
  const askedAt = Date.now();
  await expect(list(page).getByRole("link", { name: /検索 API の N\+1 を解消/ })).toBeVisible({ timeout: 3_000 });
  expect(Date.now() - askedAt).toBeLessThan(3_000);
  await expect(page.getByRole("navigation", { name: "メイン" }).getByRole("link", { name: /^Inbox/ })).toContainText("1");
});

test("同じ Issue の2つの質問は1項目にまとめ、片方に答えてももう片方は残る", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  await api.ask(a.id, "複合インデックスにしてよいですか？");
  await api.ask(a.id, "既存のインデックスは消してよいですか？");

  await page.goto("/inbox");
  await expect(list(page).getByRole("link")).toHaveCount(1);
  await expect(asks(page)).toHaveCount(2);
  const first = asks(page).filter({ hasText: "複合インデックスにしてよいですか？" });
  await first.getByRole("textbox", { name: "回答" }).fill("複合にしてよい");
  await first.getByRole("button", { name: "回答する" }).click();

  await expect(asks(page)).toHaveCount(1);
  await expect(asks(page)).toContainText("既存のインデックスは消してよいですか？");
  const shown = await api.show(a.id);
  expect(shown.questions.map((x) => x.answer)).toEqual(["複合にしてよい", null]);
  expect(shown.agentState).toBe("awaiting_input");
});

test("送信中は回答するを押せず、回答は1回だけ記録される", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  await api.ask(a.id, "複合インデックスにしてよいですか？");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/issues/*/answer", async (route) => {
    await gate;
    await route.continue();
  });

  await page.goto("/inbox");
  await asks(page).getByRole("textbox", { name: "回答" }).fill("はい");
  await asks(page).getByRole("button", { name: "回答する" }).click();
  await expect(asks(page).getByRole("button", { name: "回答する" })).toBeDisabled();
  release();

  await expect(list(page).getByText("確認依頼はありません")).toBeVisible();
  const shown = await api.show(a.id);
  expect(shown.questions).toMatchObject([{ answer: "はい" }]);
});

test.describe("別の端末で先に回答された質問", () => {
  // SSE を止めるための EventSource の失敗と、409 の応答をコンソールのエラーとして許す
  test.use({
    // 配列を fixture の値と設定の組として解釈させず、RegExp[] を渡す
    allowedConsoleErrors: async ({}, use) => {
      await use([/status of 409/, /ERR_FAILED/, /api\/events/]);
    },
  });

  test("web から回答しても先の回答を上書きせず、一覧を読み直して消す", async ({ page, nod }) => {
    // SSE を止め、別の端末での回答の後も画面に古い質問を残す
    await page.route("**/api/events", (route) => route.abort());
    const api = await seedApiWorkspace(nod);
    const a = await api.startedIssue("検索 API の N+1 を解消");
    await api.ask(a.id, "複合インデックスにしてよいですか？");

    await page.goto("/inbox");
    await expect(asks(page)).toHaveCount(1);
    await nod.me.answerQuestion(a.id, "別の端末で回答した");

    await asks(page).getByRole("textbox", { name: "回答" }).fill("web で回答した");
    await asks(page).getByRole("button", { name: "回答する" }).click();
    await expect(list(page).getByText("確認依頼はありません")).toBeVisible();
    const shown = await api.show(a.id);
    expect(shown.questions).toMatchObject([{ answer: "別の端末で回答した" }]);
  });
});

test("Issue を開くで Issue 詳細に移る", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  await api.ask(a.id, "複合インデックスにしてよいですか？");
  await page.goto("/inbox");
  await detail(page).getByRole("link", { name: "Issue を開く" }).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${a.id}$`));
});

// #185：nod.pen の 10 Inbox（pbgvS）。一覧の幅 400 は変えない
test("一覧の Header は高さ 44 で右にタブを置き、行は左右と上下に 8 の余白、角丸 8、余白 12 で、区切り線がない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issues = [];
  for (const title of ["検索 API の N+1 を解消", "決済 Webhook の再送処理", "ブログの OGP 画像を自動生成"]) {
    const issue = await api.startedIssue(title);
    await api.ask(issue.id, "インデックスを (workspace_id, created_at) の複合にしてよいですか？既存の単体インデックスは削除します。");
    issues.push(issue);
  }
  await page.goto("/inbox");
  await expect(list(page).getByRole("link")).toHaveCount(3);
  await expect(detail(page).getByRole("heading", { level: 2 })).toBeVisible();
  const m = await measureSplitList(page, "確認依頼の一覧");
  console.log(`[split] /inbox ${JSON.stringify(m)}`);
  expect(m.listWidth).toBe(400);
  expect(m.headerHeight).toBe(44);
  expect(m.headerOverflow).toBe(0);
  expect(m.title).toBe("13px / 500");
  // 題名、件数、タブが重ならずに並び、中心が揃う
  expect(m.headerParts).toBe(3);
  expect(m.headerGap).toBeGreaterThanOrEqual(8);
  expect(m.headerCenterDiff).toBeLessThanOrEqual(2.5);
  expect(m.headerRight).toBe(12);
  expect(m.tabHeights).toEqual([28]);
  expect(m.tabRadius).toEqual(["9999px"]);
  expect(m.row).toEqual({ left: 8, right: 8, top: 8, bottom: 8, radius: "8px", padding: "12px", borderTop: "0px" });
  expect(m.selectedBackground).toBe("rgb(238, 240, 243)"); // --sunken
  expect(m.titleWeights).toEqual(["500"]);

  // キーボードでも行を選べる（行はリンクのまま）
  await list(page).getByRole("link").nth(1).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`selected=${issues[1]!.id}`));
  await expect(list(page).getByRole("link").nth(1)).toHaveAttribute("data-selected", "true");
});
