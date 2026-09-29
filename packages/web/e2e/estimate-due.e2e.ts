import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { ISSUE } from "./issue-detail-data";

test.describe("Issue 詳細の見積もり・期限", () => {
  test.use({ dataset: "issue-detail" });

  test("見積もりと期限を設定・解除でき、再読み込みしても残る。期限超過を示す", async ({ page }) => {
    await page.goto(`/issues/${ISSUE.properties}`);
    const props = region(page, "プロパティ");
    const estimate = props.getByRole("button", { name: "Estimate を編集" });
    await expect(estimate).toHaveText("—");

    await estimate.click();
    await props.getByRole("textbox", { name: "Estimate" }).fill("0");
    await props.getByRole("textbox", { name: "Estimate" }).press("Enter");
    await expect(props.getByRole("alert")).toHaveText("1〜100 の整数で入力してください");
    await props.getByRole("textbox", { name: "Estimate" }).fill("3");
    await props.getByRole("textbox", { name: "Estimate" }).press("Enter");
    await expect(estimate).toHaveText("3 pt");

    const due = props.getByRole("button", { name: "Due date を編集" });
    await expect(due).toHaveText("—");
    await due.click();
    await props.getByLabel("Due date", { exact: true }).fill("2020-01-02");
    await expect(due).toContainText("2020年1月2日");
    await expect(due).toContainText("期限超過");

    await page.reload();
    const after = region(page, "プロパティ");
    await expect(after.getByRole("button", { name: "Estimate を編集" })).toHaveText("3 pt");
    await expect(after.getByRole("button", { name: "Due date を編集" })).toContainText("期限超過");

    await after.getByRole("button", { name: "Due date を編集" }).click();
    await after.getByRole("button", { name: "解除", exact: true }).click();
    await expect(after.getByRole("button", { name: "Due date を編集" })).toHaveText("—");
    await after.getByRole("button", { name: "Estimate を編集" }).click();
    await after.getByRole("textbox", { name: "Estimate" }).fill("");
    await after.getByRole("textbox", { name: "Estimate" }).press("Enter");
    await expect(after.getByRole("button", { name: "Estimate を編集" })).toHaveText("—");
    await page.reload();
    await expect(region(page, "プロパティ").getByRole("button", { name: "Estimate を編集" })).toHaveText("—");
  });

  test("Escape は入力を取り消して保存しない", async ({ page }) => {
    await page.goto(`/issues/${ISSUE.properties}`);
    const props = region(page, "プロパティ");
    await props.getByRole("button", { name: "Estimate を編集" }).click();
    await props.getByRole("textbox", { name: "Estimate" }).fill("5");
    await props.getByRole("textbox", { name: "Estimate" }).press("Escape");
    await expect(props.getByRole("button", { name: "Estimate を編集" })).toHaveText("—");
    await page.reload();
    await expect(region(page, "プロパティ").getByRole("button", { name: "Estimate を編集" })).toHaveText("—");
  });
});

test.describe("Issue 一覧の見積もり・期限列", () => {
  test.use({ dataset: "issue-list" });

  test("既定では出さず、表示設定で列と並び順を選べる。未設定は末尾、超過を示す", async ({ page, nod }) => {
    await nod.me.updateIssue("API-12", { title: "AAA 期限確認", estimate: 5, dueDate: "2020-01-02" });
    await nod.me.updateIssue("API-8", { title: "BBB 期限確認", estimate: 2, dueDate: "2999-10-01" });
    await nod.me.updateIssue("API-9", { title: "CCC 期限確認" });
    await page.goto("/issues");
    await expect(page.getByRole("columnheader")).toHaveText(["Status", "ID", "Title", "未決事項", "Workspace", "PR"]);
    await page.getByRole("textbox", { name: "検索", exact: true }).fill("期限確認");
    await page.getByText("表示設定", { exact: true }).click();
    await page.getByRole("checkbox", { name: "見積もり", exact: true }).check();
    await page.getByRole("checkbox", { name: "期限", exact: true }).check();
    await expect(page.getByRole("columnheader")).toHaveText(["Status", "ID", "Title", "未決事項", "Workspace", "PR", "見積もり", "期限"]);
    await page.getByLabel("並び順", { exact: true }).selectOption("dueDate");
    await page.getByLabel("並び順の方向", { exact: true }).selectOption("desc");
    const rows = page.getByRole("table").locator("tbody tr");
    await expect(rows.getByRole("link")).toHaveText(["BBB 期限確認", "AAA 期限確認", "CCC 期限確認"]);
    await expect(rows.nth(0)).toContainText("2 pt");
    await expect(rows.nth(0)).toContainText("2999年10月1日");
    await expect(rows.nth(0)).not.toContainText("期限超過");
    await expect(rows.nth(1)).toContainText("5 pt");
    await expect(rows.nth(1)).toContainText("2020年1月2日");
    await expect(rows.nth(1)).toContainText("期限超過");
    await page.reload();
    await expect(page.getByRole("columnheader")).toHaveText(["Status", "ID", "Title", "未決事項", "Workspace", "PR", "見積もり", "期限"]);
    await page.getByLabel("並び順", { exact: true }).waitFor({ state: "attached" });
    await expect(page).toHaveURL(/sort=dueDate/);
  });
});
