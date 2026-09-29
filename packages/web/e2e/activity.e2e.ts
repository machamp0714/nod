import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { ISSUE, MAIN_COMMENT } from "./issue-detail-data";

test.use({ dataset: "issue-detail" });

test("コメントを書くと Activity に書き手つきで出る。空白だけのコメントは送れない", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.comment}`);
  const activity = region(page, "Activity");
  const box = activity.getByRole("textbox", { name: "コメント" });
  const submit = activity.getByRole("button", { name: "コメントする" });
  await expect(submit).toBeDisabled();
  await box.fill("   ");
  await expect(submit).toBeDisabled();
  await box.fill("計測の結果を共有した");
  await submit.click();
  await expect(activity.getByRole("article", { name: "コメント記録" }).filter({ hasText: "計測の結果を共有した" })).toContainText("me");
  await expect(box).toHaveValue("");
});

test("変更の種類ごとに書き手つきの文を出し、質問の event は重ねない", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.comment}`);
  const activity = region(page, "Activity");
  await expect(activity).toContainText("me が起票した");
  await expect(activity).toContainText("me が優先度を No priority から Urgent に変えた");
  await expect(activity).toContainText("me がラベルを変えた（+docs）");
  await expect(activity).toContainText("me が説明を変えた");

  await page.goto(`/issues/${ISSUE.main}`);
  const main = region(page, "Activity");
  await expect(main.getByRole("article", { name: "コメント記録" }).filter({ hasText: MAIN_COMMENT })).toContainText("claude-code");
  await expect(main).toContainText("me が関連 Issue を足した：blocks API-13");
  await expect(main).not.toContainText("question_asked");
  await expect(main).not.toContainText("question_answered");
});
