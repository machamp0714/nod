import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";

const list = (page: Page) => page.getByRole("region", { name: "レビュー待ちの一覧" });
const detail = (page: Page) => page.getByRole("region", { name: "詳細", exact: true });

test("完了報告、PR、計画と確認依頼の数を出す", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.startedIssue("決済 Webhook の署名検証を追加");
  await nod.claude.setPlanTasks(i.id, ["署名の検証", "テスト"]);
  await nod.claude.setStep(i.id, "1", "done");
  await nod.claude.setStep(i.id, "2", "done");
  await api.ask(i.id, "失敗したときは 401 と 400 のどちらを返しますか？");
  await nod.me.answerQuestion(i.id, "401");
  await nod.claude.commentIssue(i.id, "途中の経過");
  await nod.claude.completeIssue(i.id, {
    summary: "HMAC-SHA256 で署名を検証した",
    prUrl: "https://github.com/example/api-server/pull/128",
  });

  await page.goto("/reviews");
  await expect(list(page).getByRole("link")).toHaveCount(1);
  await expect(detail(page).getByRole("heading", { level: 2, name: "決済 Webhook の署名検証を追加" })).toBeVisible();
  const report = detail(page).getByRole("region", { name: "完了報告" });
  await expect(report.getByText("claude-code の完了報告")).toBeVisible();
  await expect(report.getByText("HMAC-SHA256 で署名を検証した")).toBeVisible();
  await expect(report.getByText("途中の経過")).toHaveCount(0);
  await expect(detail(page).getByRole("link", { name: "GitHub で開く" })).toHaveAttribute("href", "https://github.com/example/api-server/pull/128");
  await expect(detail(page).getByText("計画 2/2 完了")).toBeVisible();
  await expect(detail(page).getByText("確認依頼 1 件（回答済み 1 件）")).toBeVisible();
});

test("承認すると Done になり、一覧から消える", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.inReview("決済 Webhook の署名検証を追加", "署名を検証した");
  await page.goto("/reviews");
  await detail(page).getByRole("button", { name: "承認して閉じる" }).click();
  await expect(list(page).getByText("レビュー待ちの Issue はありません")).toBeVisible();
  expect((await api.show(i.id)).status).toBe("done");
});

test("差し戻しは理由がないと押せず、理由を書くと In Progress に戻して理由をコメントに残す", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.inReview("決済 Webhook の署名検証を追加", "署名を検証した");
  await page.goto("/reviews");
  const reject = detail(page).getByRole("button", { name: "差し戻す" });
  await expect(reject).toBeDisabled();
  await detail(page).getByRole("textbox", { name: "差し戻しの理由" }).fill("改ざんされたケースのテストが足りない");
  await reject.click();

  await expect(list(page).getByText("レビュー待ちの Issue はありません")).toBeVisible();
  const shown = await api.show(i.id);
  expect(shown.status).toBe("in_progress");
  const comments = shown.activity.filter((a) => a.kind === "comment");
  expect(comments.at(-1)).toMatchObject({ actor: "me", body: "改ざんされたケースのテストが足りない" });
});

test("PR がない Issue は PR はありませんと出す", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  await api.inReview("OpenAPI の説明文を更新する", "説明文を直した");
  await page.goto("/reviews");
  await expect(detail(page).getByText("PR はありません")).toBeVisible();
});
