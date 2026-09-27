import { expect, test } from "./fixtures";

test("トップを開くとタイトルが nod のページが出る", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("nod");
});
