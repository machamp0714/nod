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

// #176：移行した Issue の「GitHub: …」「GH labels: …」のように改行だけで区切った行が1段落につながらないこと、
// タスクリストに箇条書きの「•」が重ならないこと
test("説明は改行だけの行を行のまま出し、チェックリストに箇条書きの記号を重ねない", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.description}`);
  const description = region(page, "説明");
  await description.getByRole("button", { name: "編集" }).click();
  await description.getByRole("textbox", { name: "説明" }).fill("GitHub: https://example.com/1\nGH labels: bug\n\n- [ ] 再現する\n- [x] 直す\n\n- ふつうの箇条書き");
  await description.getByRole("button", { name: "保存" }).click();

  const paragraph = description.locator("p").filter({ hasText: "GH labels: bug" });
  await expect(paragraph.locator("br")).toHaveCount(1);
  const [first, second] = await paragraph.evaluate((p) => {
    const range = document.createRange();
    const tops: number[] = [];
    for (const node of p.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      tops.push(range.getBoundingClientRect().top);
    }
    return [tops[0], tops.at(-1)];
  });
  expect(second).toBeGreaterThan(first!);

  const tasks = description.locator("li.task-list-item");
  await expect(tasks).toHaveCount(2);
  await expect(tasks.locator('input[type="checkbox"]')).toHaveCount(2);
  for (const task of await tasks.all()) await expect(task).toHaveCSS("list-style-type", "none");
  const bullet = description.getByRole("listitem").filter({ hasText: "ふつうの箇条書き" });
  await expect(bullet).toHaveCSS("list-style-type", "disc");
  // チェックボックスは、ふつうの箇条書きの記号と同じ字下げの範囲に収まる
  const taskBox = await tasks.first().locator("input").boundingBox();
  const bulletBox = await bullet.boundingBox();
  expect(taskBox!.x).toBeLessThan(bulletBox!.x);
  expect(taskBox!.x).toBeGreaterThanOrEqual(bulletBox!.x - 22);
});
