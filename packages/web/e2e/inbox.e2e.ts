import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test, waitForServerEvents } from "./fixtures";

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
  await expect(detail(page).getByText("私が残した未決事項")).toHaveCount(0);
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
  test.use({ allowedConsoleErrors: [/status of 409/, /ERR_FAILED/, /api\/events/] });

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
