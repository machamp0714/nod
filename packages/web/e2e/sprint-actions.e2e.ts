import { expect, test } from "./fixtures";

test.use({ dataset: "sprint-history" });

test("Issue詳細はSprintの由来を表示し、旧Cycle直接所属を提供しない", async ({ page }) => {
  await page.goto("/issues/AAA-1");
  const properties = page.getByRole("region", { name: "プロパティ" });
  await expect(properties.getByRole("link", { name: "過去（移行履歴）", exact: true })).toBeVisible();
  await expect(properties.getByRole("link", { name: "実行 12（採択）", exact: true })).toBeVisible();
  await expect(properties.getByRole("button", { name: "Cycle" })).toHaveCount(0);
});
