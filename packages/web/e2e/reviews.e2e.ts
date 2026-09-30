import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { measureSplitList } from "./layout-measure";

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

// #185：nod.pen の 14 Reviews（TCAVE）
test("一覧の Header は高さ 44 で題名の右に説明文と件数を置き、行は左右と上下に 8 の余白、角丸 8 で、区切り線がない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  await api.inReview("決済 Webhook の署名検証を追加", "HMAC-SHA256 で署名を検証し、失敗時は 401 を返すようにしました。テストを 6 件追加しています。");
  await api.inReview("nod issue list に --json を追加", "全コマンドで --json を受け付けるようにした");
  await page.goto("/reviews");
  await expect(list(page).getByRole("link")).toHaveCount(2);
  await expect(detail(page).getByRole("region", { name: "完了報告" })).toBeVisible();
  const description = list(page).getByText("LLM が作業を終え、確認を待っている Issue");
  await expect(description).toBeVisible();
  await expect(description).toHaveAttribute("title", "LLM が作業を終え、確認を待っている Issue");
  await expect(description).toHaveCSS("font-size", "12px");
  // 幅 400 で説明文は省略されず、全文が出る
  expect(await description.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const m = await measureSplitList(page, "レビュー待ちの一覧");
  console.log(`[split] /reviews ${JSON.stringify(m)}`);
  expect(m.listWidth).toBe(400);
  expect(m.headerHeight).toBe(44);
  expect(m.headerOverflow).toBe(0);
  expect(m.title).toBe("13px / 500");
  // 題名、説明文、件数が重ならずに並び、中心が揃う
  expect(m.headerParts).toBe(3);
  expect(m.headerGap).toBeGreaterThanOrEqual(8);
  expect(m.headerCenterDiff).toBeLessThanOrEqual(2.5);
  expect(m.headerRight).toBe(12);
  expect(m.row).toEqual({ left: 8, right: 8, top: 8, bottom: 8, radius: "8px", padding: "12px", borderTop: "0px" });
  expect(m.selectedBackground).toBe("rgb(238, 240, 243)"); // --sunken
  expect(m.titleWeights).toEqual(["500"]);
});
