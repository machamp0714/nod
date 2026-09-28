import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { ISSUE, PROJECT_NAME } from "./issue-detail-data";

test.use({ dataset: "issue-detail" });

test("プロパティを変えると保存され、再読み込みしても残る", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.properties}`);
  const props = region(page, "プロパティ");
  const status = props.getByRole("combobox", { name: "Status" });
  await expect(status).toHaveValue("backlog");
  await expect(status.getByRole("option", { name: "Needs Clarification" })).toHaveCount(0);

  await status.selectOption("todo");
  await expect(page.getByRole("group", { name: "状態" })).toContainText("Todo");
  await props.getByRole("combobox", { name: "Priority" }).selectOption({ label: "Urgent" });
  await props.getByRole("combobox", { name: "Project" }).selectOption({ label: PROJECT_NAME });
  await expect(page.getByRole("navigation", { name: "パンくず" }).getByRole("link", { name: PROJECT_NAME })).toBeVisible();
  await props.getByRole("combobox", { name: "Assignee" }).selectOption("codex");

  await props.getByRole("textbox", { name: "ラベルを追加" }).fill("api, docs");
  await props.getByRole("button", { name: "追加", exact: true }).click();
  await expect(props.getByRole("button", { name: "ラベル api を外す" })).toBeVisible();
  await expect(props.getByRole("textbox", { name: "ラベルを追加" })).toHaveValue("");
  await props.getByRole("button", { name: "ラベル api を外す" }).click();
  await expect(props.getByRole("button", { name: "ラベル api を外す" })).toHaveCount(0);

  await page.reload();
  const after = region(page, "プロパティ");
  await expect(after.getByRole("combobox", { name: "Status" })).toHaveValue("todo");
  await expect(after.getByRole("combobox", { name: "Priority" })).toHaveValue("1");
  await expect(after.getByRole("combobox", { name: "Project" })).toHaveValue("1");
  await expect(after.getByRole("combobox", { name: "Assignee" })).toHaveValue("codex");
  await expect(after.getByRole("button", { name: "ラベル docs を外す" })).toBeVisible();
});

test("Needs Clarification の Issue は、今の値として表示するが選べない", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.clarify}`);
  const status = region(page, "プロパティ").getByRole("combobox", { name: "Status" });
  await expect(status).toHaveValue("needs_clarification");
  await expect(status.getByRole("option", { name: "Needs Clarification" })).toBeDisabled();
});
