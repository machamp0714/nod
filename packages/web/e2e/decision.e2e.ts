import { expect, test } from "./fixtures";

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
