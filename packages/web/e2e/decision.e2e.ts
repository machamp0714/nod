import { expect, test } from "./fixtures";

test("Inbox は LLM の確認依頼を並べ、先頭の項目の詳細を出す", async ({ page }) => {
  await page.goto("/inbox");
  const list = page.getByRole("region", { name: "確認依頼の一覧" });
  await expect(list.getByRole("link")).toHaveCount(3);
  const detail = page.getByRole("region", { name: "詳細", exact: true });
  await expect(detail.getByRole("heading", { level: 2, name: "検索 API の N+1 を解消" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "確認依頼", exact: true }).getByText("既存の created_at 単独のインデックスは消してよいですか？", { exact: false }),
  ).toBeVisible();
  await expect(detail.getByText("実行場所：api-server / feat-search-n1")).toBeVisible();
  await expect(detail.getByRole("textbox", { name: "回答" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "回答する" })).toBeDisabled();
});

test("Inbox の項目を押すと、URL の selected と詳細が変わる", async ({ page }) => {
  await page.goto("/inbox");
  await page.getByRole("region", { name: "確認依頼の一覧" }).getByRole("link", { name: /決済 Webhook の再送処理/ }).click();
  await expect(page).toHaveURL(/selected=API-8/);
  await expect(page.getByRole("heading", { level: 2, name: "決済 Webhook の再送処理" })).toBeVisible();
});

test("selected が一覧にない ID なら先頭の項目を出す", async ({ page }) => {
  await page.goto("/inbox?selected=NOPE-1");
  await expect(page.getByRole("heading", { level: 2, name: "検索 API の N+1 を解消" })).toBeVisible();
});

test("Inbox は直近の経過と Issue へのリンクを出す", async ({ page }) => {
  await page.goto("/inbox");
  const detail = page.getByRole("region", { name: "詳細", exact: true });
  await expect(detail.getByText("N+1 の原因は検索結果ごとの workspace 取得だった", { exact: false })).toBeVisible();
  await detail.getByRole("link", { name: "Issue を開く" }).click();
  await expect(page).toHaveURL(/\/issues\/API-12$/);
});

test("Reviews は完了報告と PR を出し、判断のボタンを置く", async ({ page }) => {
  await page.goto("/reviews");
  const detail = page.getByRole("region", { name: "詳細", exact: true });
  await expect(detail.getByRole("heading", { level: 2, name: "決済 Webhook の署名検証を追加" })).toBeVisible();
  await expect(detail.getByText("claude-code の完了報告")).toBeVisible();
  await expect(detail.getByRole("link", { name: "GitHub で開く" })).toHaveAttribute("href", "https://github.com/example/api-server/pull/128");
  await expect(detail.getByText("確認依頼 1 件（回答済み 1 件）")).toBeVisible();
  await expect(detail.getByRole("button", { name: "承認して閉じる" })).toBeDisabled();
  await expect(detail.getByRole("button", { name: "差し戻す" })).toBeDisabled();
});

test("Triage は起票者と4つの判断のボタンを出す", async ({ page }) => {
  await page.goto("/triage");
  await expect(page.getByRole("region", { name: "Triage の一覧" }).getByRole("link")).toHaveCount(2);
  const detail = page.getByRole("region", { name: "詳細", exact: true });
  await expect(detail.getByRole("heading", { level: 2, name: "検索結果のページングが 1 件ずれる" })).toBeVisible();
  await expect(detail.getByText(/claude-code が起票/)).toBeVisible();
  for (const name of ["受け入れる", "重複にする", "後回し", "却下"]) {
    await expect(detail.getByRole("button", { name })).toBeDisabled();
  }
});
