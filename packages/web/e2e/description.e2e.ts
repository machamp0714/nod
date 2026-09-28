import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { ISSUE } from "./issue-detail-data";

test.use({ dataset: "issue-detail" });

test("説明の Markdown を、見出しを1段下げて描画する", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.main}`);
  const description = region(page, "説明");
  await expect(description.getByRole("heading", { level: 3, name: "受け入れ条件" })).toBeVisible();
  await expect(description.getByRole("listitem")).toHaveText(["100 件の検索でクエリが 3 回以下", "p95 が 200ms 以下"]);
});

test("説明を編集して保存すると残り、生の HTML は描画せず、空白だけなら説明なしになる", async ({ page }) => {
  let dialogs = 0;
  page.on("dialog", (dialog) => {
    dialogs += 1;
    void dialog.dismiss();
  });
  await page.goto(`/issues/${ISSUE.description}`);
  const description = region(page, "説明");
  await expect(description).toContainText("初期の説明");

  await description.getByRole("button", { name: "編集" }).click();
  const box = description.getByRole("textbox", { name: "説明" });
  await expect(box).toHaveValue("初期の説明");
  await box.fill('## 手順\n\n- `bun install` を実行する\n\n<b>太字</b><img src="x" onerror="alert(1)">');
  await description.getByRole("button", { name: "保存" }).click();
  await expect(description.getByRole("heading", { level: 3, name: "手順" })).toBeVisible();
  await expect(description.locator("code")).toHaveText("bun install");
  await expect(description.locator("b, img")).toHaveCount(0);
  await expect(description).toContainText("<b>太字</b>");

  await page.reload();
  await expect(region(page, "説明").getByRole("heading", { level: 3, name: "手順" })).toBeVisible();

  await region(page, "説明").getByRole("button", { name: "編集" }).click();
  await region(page, "説明").getByRole("textbox", { name: "説明" }).fill("捨てる説明");
  await region(page, "説明").getByRole("button", { name: "キャンセル" }).click();
  await expect(region(page, "説明")).not.toContainText("捨てる説明");
  await expect(region(page, "説明").getByRole("heading", { level: 3, name: "手順" })).toBeVisible();

  await region(page, "説明").getByRole("button", { name: "編集" }).click();
  await region(page, "説明").getByRole("textbox", { name: "説明" }).fill("  \n ");
  await region(page, "説明").getByRole("button", { name: "保存" }).click();
  await expect(region(page, "説明")).toContainText("説明はありません");
  expect(dialogs).toBe(0);
});
