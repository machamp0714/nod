import { expect, test } from "./fixtures";

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
