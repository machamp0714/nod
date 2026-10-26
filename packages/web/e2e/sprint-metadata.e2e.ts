import { expect, test } from "./fixtures";

test.use({ dataset: "sprint-history" });

test("現在の完了数はタスク完了として表示し、ゴール達成率へ読み替えない", async ({ page }) => {
  await page.goto("/sprints/12");
  const overview = page.getByRole("region", { name: "Sprint の概要" });
  await expect(overview).toContainText("タスク完了");
  await expect(overview).toContainText("1/7");
  await expect(overview).toContainText("未完了 6");
  await expect(page.getByText("達成結果: 不明", { exact: false })).toBeVisible();
});
