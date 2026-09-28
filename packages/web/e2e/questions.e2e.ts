import type { Page } from "@playwright/test";
import { expect, test, waitForServerEvents } from "./fixtures";
import { region } from "./helpers";
import { CLARIFY_QUESTIONS, ISSUE, LLM_QUESTION, MAIN_OPEN_QUESTION, STALE_QUESTION } from "./issue-detail-data";

test.use({ dataset: "issue-detail" });

const item = (page: Page, text: string) => region(page, "未決事項").getByRole("listitem").filter({ hasText: text });
const state = (page: Page) => page.getByRole("group", { name: "状態" });

async function record(page: Page, question: string, answer: string) {
  await item(page, question).getByRole("button", { name: "回答を記録" }).click();
  await item(page, question).getByRole("textbox", { name: "回答" }).fill(answer);
  await item(page, question).getByRole("button", { name: "記録する" }).click();
}

// 完了条件：Issue 詳細で未決事項に回答を記録する流れ
test("未決事項に1つずつ回答を記録すると決定数が進み、すべて決まると元のステータスに戻る", async ({ page }) => {
  const [first, second] = CLARIFY_QUESTIONS;
  await page.goto(`/issues/${ISSUE.clarify}`);
  const panel = region(page, "未決事項");
  await expect(panel).toContainText("0 / 2 決定");
  await expect(state(page)).toContainText("Needs Clarification");

  await record(page, first, "0 限定");
  await expect(panel).toContainText("1 / 2 決定");
  await expect(item(page, first)).toContainText("回答：0 限定");
  await expect(item(page, first).getByRole("button", { name: "回答を記録" })).toHaveCount(0);
  await expect(state(page)).toContainText("Needs Clarification");

  await record(page, second, "プレースホルダーで見せる");
  await expect(panel).toContainText("2 / 2 決定");
  await expect(state(page)).toContainText("Todo");
  await expect(state(page)).not.toContainText("Needs Clarification");

  await page.reload();
  await expect(region(page, "未決事項")).toContainText("2 / 2 決定");
  await expect(item(page, second)).toContainText("回答：プレースホルダーで見せる");
  await expect(region(page, "Activity")).toContainText(`me の確認依頼に me が回答した：${first}`);
});

test("LLM の質問に回答すると、作業状況が作業中に戻る。空白だけの回答は送れない", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.llmQuestion}`);
  await expect(state(page)).toContainText("入力待ち");
  const question = item(page, LLM_QUESTION);
  await question.getByRole("button", { name: "回答を記録" }).click();
  const submit = question.getByRole("button", { name: "記録する" });
  await expect(submit).toBeDisabled();
  await question.getByRole("textbox", { name: "回答" }).fill("   ");
  await expect(submit).toBeDisabled();
  await question.getByRole("textbox", { name: "回答" }).fill("5 回に揃えてください");
  await submit.click();
  await expect(region(page, "未決事項")).toContainText("1 / 1 決定");
  await expect(state(page)).toContainText("作業中");
});

test("回答のフォームはキャンセルで閉じる", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.main}`);
  const question = item(page, MAIN_OPEN_QUESTION);
  await question.getByRole("button", { name: "回答を記録" }).click();
  await question.getByRole("button", { name: "キャンセル" }).click();
  await expect(question.getByRole("textbox", { name: "回答" })).toHaveCount(0);
  await expect(region(page, "未決事項")).toContainText("1 / 2 決定");
});

test("質問文をコピーする", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/issues/${ISSUE.main}`);
  await item(page, MAIN_OPEN_QUESTION).getByRole("button", { name: "質問文をコピー" }).click();
  await expect(region(page, "未決事項").getByRole("status")).toHaveText("質問文をコピーしました");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MAIN_OPEN_QUESTION);
});

test("未決事項を追加すると Needs Clarification になり、同じ文面は増やさない", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.addQuestion}`);
  const panel = region(page, "未決事項");
  await expect(panel).toContainText("未決事項はありません");

  async function add(text: string) {
    await panel.getByRole("button", { name: "未決事項を追加" }).click();
    await expect(panel.getByRole("button", { name: "追加する" })).toBeDisabled();
    await panel.getByRole("textbox", { name: "未決事項" }).fill(text);
    await panel.getByRole("button", { name: "追加する" }).click();
  }

  await add("API の破壊的変更を許すか");
  await expect(panel).toContainText("0 / 1 決定");
  await expect(state(page)).toContainText("Needs Clarification");
  await expect(panel.getByRole("textbox", { name: "未決事項" })).toHaveCount(0);

  await add("  API の破壊的変更を許すか ");
  await expect(panel.getByRole("status")).toHaveText("同じ未決事項がすでにあります");
  await expect(panel.getByRole("listitem")).toHaveCount(1);
});

test.describe("別の場所で先に回答された質問", () => {
  test.use({ allowedConsoleErrors: [/status of 409/] });

  test("記録できなかったことを示し、最新の回答を出す", async ({ page, request }) => {
    await page.goto(`/issues/${ISSUE.stale}`);
    // ready による読み直しが、先に回答した後に起きると、フォームを押す前に画面が最新になってしまう
    await waitForServerEvents(page);
    const question = item(page, STALE_QUESTION);
    await question.getByRole("button", { name: "回答を記録" }).click();

    // 別のタブで先に回答された状態を、server の API で作る。
    // server 自身の書き込みでは SSE の change が来ないため、画面は古いまま残る（nod.me.answerQuestion で書くと change が届き、フォームを押す前に画面が最新になる）
    const detail = await (await request.get(`/api/issues/${ISSUE.stale}`)).json();
    const res = await request.post(`/api/issues/${ISSUE.stale}/answer`, {
      data: { answer: "10 分にする", questionId: detail.questions[0].id },
    });
    expect(res.ok()).toBe(true);

    await question.getByRole("textbox", { name: "回答" }).fill("5 分にする");
    await question.getByRole("button", { name: "記録する" }).click();
    await expect(region(page, "未決事項").getByRole("alert")).toContainText("記録できませんでした");
    await expect(question).toContainText("回答：10 分にする");
    await expect(region(page, "未決事項")).toContainText("1 / 1 決定");
  });
});
